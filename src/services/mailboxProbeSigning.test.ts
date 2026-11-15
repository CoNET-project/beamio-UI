/**
 * run-time proof of the probe signature decision, with the dependencies replaced by fakes. SYNTHETIC values only.
 *  - a shell with no page key sends mailboxProbeSign and never calls the page signer;
 *  - a native refusal in a shell is null, with no page fallback;
 *  - a browser keeps the page signature, for the two probe commands only;
 *  - any other command is refused in both environments, and nothing is signed.
 */
import { MAILBOX_PROBE_COMMANDS, probeHasSigner, signMailboxProbe, type MailboxProbeSigningDeps } from './mailboxProbeSigning'
import type { MailboxProbeSignOutcome } from './nativeMailboxProbe'

const EOA = '0xabCDeF0123456789AbcdEf0123456789aBCDEF01'
const TARGET_LOWER = '0x1234567890abcdef1234567890abcdef12345678'
const TARGET = '0x1234567890AbcdEF1234567890aBcdef12345678'
const NOW = 1762000000
const SIG = '0x' + 'cd'.repeat(65)
const NATIVE_MESSAGE = '{"command":"wallet_online_query","walletAddress":"0xabCDeF0123456789AbcdEf0123456789aBCDEF01","targetWallet":"0x1234567890AbcdEF1234567890aBcdef12345678","timestamp":1762000000}'

function fakes(over: Partial<MailboxProbeSigningDeps> & { native?: MailboxProbeSignOutcome } = {}) {
	const calls = { native: [] as unknown[], page: [] as unknown[][] }
	const deps: MailboxProbeSigningDeps = {
		isShell: () => false,
		nativeProbeSign: async (args) => {
			calls.native.push(args)
			return over.native ?? { ok: true, message: NATIVE_MESSAGE, signature: SIG }
		},
		accountEoaFor: () => EOA,
		pageSign: async (message, armor) => {
			calls.page.push([message, armor])
			return SIG
		},
		checksumAddress: (a) => (a.toLowerCase() === TARGET_LOWER ? TARGET : (() => { throw new Error('bad address') })()),
		nowSeconds: () => NOW,
		...over,
	}
	return { deps, calls }
}

describe('a shell with no page key', () => {
	it('sends mailboxProbeSign with the three fields and never calls the page signer; the answer is the native message and signature', async () => {
		const { deps, calls } = fakes({ isShell: () => true })
		const out = await signMailboxProbe('wallet_online_query', TARGET_LOWER, '', deps)
		expect(out).toEqual({ message: NATIVE_MESSAGE, signMessage: SIG })
		expect(calls.native).toEqual([{ command: 'wallet_online_query', targetWallet: TARGET, timestamp: NOW }])
		expect(calls.page).toEqual([])
	})

	it('the wake kind is sent the same way, with its own command name', async () => {
		const { deps, calls } = fakes({ isShell: () => true })
		await signMailboxProbe('wallet_native_wake_query', TARGET, '', deps)
		expect(calls.native).toEqual([{ command: 'wallet_native_wake_query', targetWallet: TARGET, timestamp: NOW }])
		expect(calls.page).toEqual([])
	})

	it('a native refusal (no capability, no key, locked, not ready) is null, and the page signer is not used', async () => {
		for (const reason of ['not_supported', 'no_key', 'locked', 'not_ready', 'native_unavailable']) {
			const { deps, calls } = fakes({ isShell: () => true, native: { ok: false, reason } })
			await expect(signMailboxProbe('wallet_online_query', TARGET, '', deps)).resolves.toBeNull()
			expect(calls.native).toHaveLength(1)
			expect(calls.page).toEqual([])
		}
	})

	it('a malformed native answer (refused as bad_ack by the command) is also null with no fallback', async () => {
		const { deps, calls } = fakes({ isShell: () => true, native: { ok: false, reason: 'bad_ack' } })
		await expect(signMailboxProbe('wallet_online_query', TARGET, '', deps)).resolves.toBeNull()
		expect(calls.page).toEqual([])
	})

	it('a native transport error is not swallowed here: it rejects, and the page signer is still not used', async () => {
		const { deps, calls } = fakes({
			isShell: () => true,
			nativeProbeSign: async () => {
				throw new Error('bridge down')
			},
		})
		await expect(signMailboxProbe('wallet_online_query', TARGET, '', deps)).rejects.toThrow('bridge down')
		expect(calls.page).toEqual([])
	})
})

describe('a browser keeps its page signature, for the two probe commands', () => {
	it('signs the probe text with the page key; the native command is not used', async () => {
		const { deps, calls } = fakes({ isShell: () => false })
		const out = await signMailboxProbe('wallet_online_query', TARGET_LOWER, 'PAGE-ARMOR', deps)
		expect(out).not.toBeNull()
		expect(out!.signMessage).toBe(SIG)
		expect(calls.native).toEqual([])
		expect(calls.page).toHaveLength(1)
		expect(calls.page[0][1]).toBe('PAGE-ARMOR')
	})

	it('the probe text has the spec order and no spaces: command, walletAddress, targetWallet (checksum), timestamp', async () => {
		const { deps, calls } = fakes({ isShell: () => false })
		const out = await signMailboxProbe('wallet_native_wake_query', TARGET_LOWER, 'PAGE-ARMOR', deps)
		expect(out!.message).toBe(
			`{"command":"wallet_native_wake_query","walletAddress":"${EOA}","targetWallet":"${TARGET}","timestamp":${NOW}}`,
		)
		expect(calls.page[0][0]).toBe(out!.message)
	})

	it('a browser signing failure rejects (the caller stops the probe); there is no native call', async () => {
		const { deps, calls } = fakes({
			isShell: () => false,
			pageSign: async () => {
				throw new Error('sign failed')
			},
		})
		await expect(signMailboxProbe('wallet_online_query', TARGET, 'PAGE-ARMOR', deps)).rejects.toThrow('sign failed')
		expect(calls.native).toEqual([])
	})
})

describe('only the two probe commands are accepted, in either environment', () => {
	it('the command list is exactly the two probe kinds', () => {
		expect([...MAILBOX_PROBE_COMMANDS].sort()).toEqual(['wallet_native_wake_query', 'wallet_online_query'])
	})

	it('any other command is null in a shell and in a browser; nothing is sent or signed', async () => {
		for (const isShell of [true, false]) {
			const { deps, calls } = fakes({ isShell: () => isShell })
			const out = await signMailboxProbe('wallet_send' as never, TARGET, 'PAGE-ARMOR', deps)
			expect(out).toBeNull()
			expect(calls.native).toEqual([])
			expect(calls.page).toEqual([])
		}
	})

	it('an address that is not an address stops the probe before any call', async () => {
		const { deps, calls } = fakes({ isShell: () => true })
		await expect(signMailboxProbe('wallet_online_query', '0x12', '', deps)).rejects.toThrow('bad address')
		expect(calls.native).toEqual([])
		expect(calls.page).toEqual([])
	})
})

describe('the probe needs a signer: a shell by its native command, a browser by its page key', () => {
	it('a shell with no page key has a signer', () => {
		expect(probeHasSigner(true, '')).toBe(true)
		expect(probeHasSigner(true, undefined)).toBe(true)
		expect(probeHasSigner(true, '   ')).toBe(true)
	})

	it('a browser needs its own key', () => {
		expect(probeHasSigner(false, '')).toBe(false)
		expect(probeHasSigner(false, '   ')).toBe(false)
		expect(probeHasSigner(false, null)).toBe(false)
		expect(probeHasSigner(false, 'PAGE-ARMOR')).toBe(true)
	})
})
