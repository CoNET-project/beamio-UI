/**
 * MP-20 (M6 v3.3): after the user changes the passcode in the page, the NEXT unlock sends pwaWalletSync{eoa, cipher, passcode, seq} where the cipher is the
 * page's CURRENT envelope (the one the change re-sealed, read from the page record at that moment) and the passcode is the new one just typed. The
 * old envelope and the phrase are never sent. (A store-only sync of different bytes is refused by the native side, so this unlock sync is what moves the
 * native envelope after a change: known behaviour in the spec.)
 */
import { afterUiUnlock } from './passcode/uiUnlockNative'
import { resetShellSyncStatus } from './shellSyncStatus'

const EOA = '0x1111111111111111111111111111111111111111'
const OLD_PASSCODE = '111111'
const NEW_PASSCODE = '654321'
const envelope = (ct: string) => ({ v: 3, mode: 'passcode', alg: 'AES-256-GCM', kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: `salt-${ct}`, iv: `iv-${ct}`, ct, eoa: EOA })

beforeEach(() => resetShellSyncStatus())

describe('MP-20 the unlock after a passcode change', () => {
	it('sends the current page envelope (read at that moment) with the new passcode; never the old envelope or a phrase', async () => {
		let pageRecord = envelope('CT_OLD')
		const sent: Array<{ cipher: Record<string, unknown>; eoa: string; passcode: string }> = []
		const commands: Array<Record<string, unknown>> = []
		const deps = {
			probe: async () => ({ answered: true, capabilities: [] as string[] }),
			send: async (cmd: Record<string, unknown>) => { commands.push(cmd); return null },
			readCipher: async () => ({ ...pageRecord }) as Record<string, unknown>,
			syncCipher: async (cipher: Record<string, unknown>, eoa: string, passcode: string) => { sent.push({ cipher, eoa, passcode }); return { kind: 'synced' } },
		}
		// first unlock with the old passcode and the old envelope
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: OLD_PASSCODE }, deps)
		// the user changes the passcode in the page: the record now holds the re-sealed envelope
		pageRecord = envelope('CT_NEW')
		// the next unlock (a later page session): the new passcode, the envelope read now
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: NEW_PASSCODE }, deps)
		expect(sent.length).toBe(2)
		expect(sent[0]).toMatchObject({ eoa: EOA, passcode: OLD_PASSCODE, cipher: { ct: 'CT_OLD' } })
		expect(sent[1]).toMatchObject({ eoa: EOA, passcode: NEW_PASSCODE, cipher: { ct: 'CT_NEW' } })
		expect(sent[1].cipher.ct).not.toBe('CT_OLD')
		expect(commands).toEqual([]) // no phrase command, no passcodeUnlock, nothing else
	})
	it('the envelope is read again at every unlock (it is not remembered between unlocks)', async () => {
		let reads = 0
		const deps = {
			probe: async () => ({ answered: true, capabilities: [] as string[] }),
			send: async () => null,
			readCipher: async () => { reads += 1; return envelope(`CT_${reads}`) as Record<string, unknown> },
			syncCipher: async () => ({ kind: 'synced' }),
		}
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: NEW_PASSCODE }, deps)
		await afterUiUnlock({ shell: true, eoa: EOA, passcode: NEW_PASSCODE }, deps)
		expect(reads).toBe(2)
	})
})
