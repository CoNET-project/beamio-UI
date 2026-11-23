/**
 * MP-19 / SC-09 (run-time half): the whole M6 flow is run (passcode account, no-passcode account, wrong passcode, read fault, no answer, refusal) with every
 * console output and every native-log line captured. None of them may contain the synthetic passcode, the mnemonic, the derived key material or the
 * ciphertext fields. Synthetic values only.
 */
import { afterUiUnlock } from './passcode/uiUnlockNative'
import { createShellMnemonicSync, type ShellSyncAnswer } from './shellMnemonicSync'
import { openMnemonicV3, setMnemonicKdfForTest } from './passcode/mnemonicCipherV3'
import { resetShellSyncStatus } from './shellSyncStatus'

const logged: string[] = []
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (_level: string, text: string) => logged.push(String(text)) }))

const EOA = '0x1111111111111111111111111111111111111111'
const PASSCODE = '739204'
const PHRASE = 'zebra yellow wheel violin utility trumpet sunset ribbon quantum pencil orbit nectar'
const CT = 'UTkzX0NJUEhFUl9URVhUX1NFQ1JFVA'
const SALT = 'U0FMVF9TRUNSRVRfVkFMVUU'
const IV = 'SVZfU0VDUkVU'
const CIPHER = { v: 3, mode: 'passcode', alg: 'AES-256-GCM', kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: SALT, iv: IV, ct: CT, eoa: EOA }
const SECRETS = [PASSCODE, PHRASE, CT, SALT, IV, 'zebra yellow', 'quantum pencil']

const spies: jest.SpyInstance[] = []
beforeEach(() => {
	logged.length = 0
	resetShellSyncStatus()
	for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		spies.push(jest.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ')) }))
	}
})
afterEach(() => {
	while (spies.length) spies.pop()!.mockRestore()
	setMnemonicKdfForTest(null)
})

const makeDeps = (reply: unknown) => {
	const sync = createShellMnemonicSync({
		send: async () => 'ok' as ShellSyncAnswer,
		sendCipher: async () => {
			if (reply instanceof Error) throw reply
			return reply as never
		},
		retryDelaysMs: [1],
		wait: async () => undefined,
		log: (m) => console.warn(m),
		bridgeAvailable: () => true,
		nextSeq: (() => { let n = 0; return () => ++n })(),
	})
	return {
		probe: async () => ({ answered: true, capabilities: [] as string[] }),
		send: async () => null,
		readCipher: async () => CIPHER as Record<string, unknown>,
		syncCipher: (c: Record<string, unknown>, e: string, p: string) => sync.syncCipher(c, e, p),
	}
}

const noSecret = (): void => {
	const all = logged.join('\n')
	for (const s of SECRETS) expect(all).not.toContain(s)
}

describe('MP-19 / SC-09 run-time: nothing secret reaches the console or the native-log channel', () => {
	it.each([
		['synced', { code: 'ok' }],
		['unlock_failed', { code: 'unlock_failed' }],
		['verify_failed', { code: 'verify_failed' }],
		['read fault', { code: 'write_failed', reason: 'internal_state' }],
		['gate refused', { code: 'key_over_bridge_refused' }],
		['no answer', { code: 'no_answer' }],
		['a throwing sender', new Error(`bridge failed for ${'a-reqId-only'}`)],
	])('the passcode unlock sync, %s', async (_n, reply) => {
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: PASSCODE }, makeDeps(reply))
		noSecret()
	})

	it('the no-passcode sync path (phrase) logs no phrase', async () => {
		const sync = createShellMnemonicSync({
			send: async () => 'no_answer' as ShellSyncAnswer,
			retryDelaysMs: [1],
			wait: async () => undefined,
			log: (m) => console.warn(m),
			bridgeAvailable: () => true,
			nextSeq: (() => { let n = 0; return () => ++n })(),
		})
		await sync.sync(PHRASE, EOA)
		noSecret()
	})

	it('a wrong passcode against the real envelope check logs nothing secret (the KDF is the test double)', async () => {
		setMnemonicKdfForTest(async () => new Uint8Array(32))
		const r = await openMnemonicV3(CIPHER, PASSCODE)
		expect(r.code).not.toBe('ok')
		noSecret()
	})
})
