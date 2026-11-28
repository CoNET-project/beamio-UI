/**
 * @jest-environment node
 *
 * path A of the cold-start handoff (homeBridgeHandoff.ts) within ONE start cycle, and how it fits with paths B and C.
 * A sends only when this process has just finished Create / Restore (a pending exists); B (coldStartPageValid) and C (passcode unlock) carry the every-cold-start duty. Per start cycle exactly one valid handoff;
 * a repeated or concurrent entry to /home within the same start sends nothing more.
 * Limit (said plainly): A is driven here as a unit; B and C live in AppEntryGate / PasscodeLockScreen and are covered by source-structure checks below, not by an integrated run of the three together.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0xa8E070649A1D98651D281FdD428BD3EeC0d279e0'

const mockIsShell = jest.fn(() => true)
const mockAvailable = jest.fn(() => true)
const mockSend = jest.fn(async (..._a: unknown[]) => ({ code: 'ok' as const }))
const mockSendCipher = jest.fn(async (..._a: unknown[]) => ({ code: 'ok' as const }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ isCashTreesNativeWebView: () => mockIsShell() }))
jest.mock('./pwaWalletSyncTransport', () => ({
	pwaWalletSyncTransportAvailable: () => mockAvailable(),
	sendPwaWalletSync: (...a: unknown[]) => mockSend(...a),
	sendPwaWalletSyncCipher: (...a: unknown[]) => mockSendCipher(...a),
}))
jest.mock('./nativeWallet', () => ({ notifyNativeWalletReady: jest.fn() }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./passcode/mnemonicCipherV3', () => ({ sealMnemonicV3: async () => ({ v: 3 }) }))
let mockSeqNo = 100
jest.mock('./shellTxSeq', () => ({ nextShellTxSeq: () => ++mockSeqNo }))

import { resetHomeBridgeHandoffForTests, runColdStartHomeHandoffOnce, setPendingHomeMnemonicHandoff, isHomeHandoffDone } from './homeBridgeHandoff'

const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('homeBridgeHandoff: one valid handoff per start cycle', () => {
	beforeEach(() => {
		resetHomeBridgeHandoffForTests()
		jest.clearAllMocks()
		mockSeqNo = 100
		mockIsShell.mockReturnValue(true)
		mockAvailable.mockReturnValue(true)
		mockSend.mockResolvedValue({ code: 'ok' })
		mockSendCipher.mockResolvedValue({ code: 'ok' })
	})

	it('A with a pending (just created / restored): exactly one pwaWalletSync for repeated and concurrent /home entries', async () => {
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'demo' })
		const [r1, r2, r3] = await Promise.all([runColdStartHomeHandoffOnce(), runColdStartHomeHandoffOnce(), runColdStartHomeHandoffOnce()])
		expect([r1, r2, r3]).toEqual(['ok', 'ok', 'ok']) // the concurrent entries joined the one attempt
		expect(mockSend).toHaveBeenCalledTimes(1)
		const r4 = await runColdStartHomeHandoffOnce() // /home entered again in the same start
		const r5 = await runColdStartHomeHandoffOnce()
		expect([r4, r5]).toEqual(['skipped', 'skipped'])
		expect(mockSend).toHaveBeenCalledTimes(1)
		expect(mockSendCipher).not.toHaveBeenCalled()
		expect(isHomeHandoffDone()).toBe(true)
	})

	it('A with a pending and a passcode: exactly one sealed delivery, none after', async () => {
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'demo', passcode: '123456' })
		expect(await runColdStartHomeHandoffOnce()).toBe('ok')
		expect(await runColdStartHomeHandoffOnce()).toBe('skipped')
		expect(mockSend).not.toHaveBeenCalled() // a passcode account never sends the plain phrase
		expect(mockSendCipher).toHaveBeenCalledTimes(1)
	})

	it('a failed attempt keeps the pending and the same seq for the retry (one logical handoff), then stops after ok', async () => {
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'demo' })
		mockSend.mockResolvedValueOnce({ code: 'busy' } as never)
		expect(await runColdStartHomeHandoffOnce()).toBe('retry')
		expect(await runColdStartHomeHandoffOnce()).toBe('ok')
		expect(await runColdStartHomeHandoffOnce()).toBe('skipped')
		expect(mockSend).toHaveBeenCalledTimes(2)
		expect(mockSend.mock.calls[0][1]).toBe(mockSend.mock.calls[1][1]) // the same seq (idempotent on the shell)
	})

	it('cold start (B or C cycle: no pending in this process): A sends nothing and is final for this start (no_pending)', async () => {
		expect(await runColdStartHomeHandoffOnce()).toBe('skipped')
		expect(mockSend).not.toHaveBeenCalled()
		expect(isHomeHandoffDone()).toBe(true)
		// characterisation: a pending that appears AFTER the no_pending answer is not sent by A in this start (the flag is per process)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'demo' })
		expect(await runColdStartHomeHandoffOnce()).toBe('skipped')
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('browser: no bridge at all', async () => {
		mockIsShell.mockReturnValue(false)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'demo' })
		expect(await runColdStartHomeHandoffOnce()).toBe('browser')
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('structure: A has one caller (the /home effect of Home.tsx, only on "/"), and its pending is set only at "You\'re all set"', () => {
		const home = src('components/Home/Home.tsx')
		expect((home.match(/runColdStartHomeHandoffOnce\(\)/g) || []).length).toBe(1)
		expect(home).toMatch(/if \(location\.pathname !== '\/'\) return;?\s*void runColdStartHomeHandoffOnce\(\)/)
		const loading = src('pages/Home/LoadingPage.tsx')
		expect((loading.match(/setPendingHomeMnemonicHandoff\(\{/g) || []).length).toBe(1)
	})

	it('structure: B and C carry the every-cold-start duty and are each guarded against a second send', () => {
		const gate = src('components/AppEntryGate.tsx')
		// B: the valid page mnemonic at the start judgement sends through sendPhraseOnce, which refuses a key that is confirmed or in flight
		expect(gate).toMatch(/\[syncSender\] src=coldStartPageValid/)
		expect(gate).toMatch(/const sendPhraseOnce = async[\s\S]{0,200}if \(sets\.confirmed\.has\(key\) \|\| sets\.inFlight\.has\(key\)\) return/)
		// C: the passcode account syncs once per page session after the unlock
		expect(gate).toMatch(/once per page session, after the page unlock/)
	})

	it('the comment of the no_pending branch no longer says the PWA must never resend the phrase', () => {
		const code = src('services/homeBridgeHandoff.ts')
		expect(code).not.toMatch(/PWA must not resend phrase/)
		expect(code).toMatch(/carried by\s*\n\s*\/\/ the other two paths/)
	})
})
