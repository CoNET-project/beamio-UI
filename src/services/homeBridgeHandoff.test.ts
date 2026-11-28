/**
 * @jest-environment node
 */
const PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0xa8E070649A1D98651D281FdD428BD3EeC0d279e0'

const mockIsCashTreesNativeWebView = jest.fn(() => false)
const mockPwaWalletSyncTransportAvailable = jest.fn(() => true)
const mockSendPwaWalletSync = jest.fn(async () => ({ code: 'ok' as const }))
const mockSendPwaWalletSyncCipher = jest.fn(async () => ({ code: 'ok' as const }))
const mockNextShellTxSeq = jest.fn(() => 42)

jest.mock('@/utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: (...args: unknown[]) => mockIsCashTreesNativeWebView(...args),
}))

jest.mock('./pwaWalletSyncTransport', () => ({
	pwaWalletSyncTransportAvailable: (...args: unknown[]) => mockPwaWalletSyncTransportAvailable(...args),
	sendPwaWalletSync: (...args: unknown[]) => mockSendPwaWalletSync(...args),
	sendPwaWalletSyncCipher: (...args: unknown[]) => mockSendPwaWalletSyncCipher(...args),
}))

const mockNotifyNativeWalletReady = jest.fn()
jest.mock('./nativeWallet', () => ({
	notifyNativeWalletReady: (...args: unknown[]) => mockNotifyNativeWalletReady(...args),
}))

const mockPublishNativePwaLog = jest.fn()
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (...args: unknown[]) => mockPublishNativePwaLog(...args),
}))

jest.mock('./shellTxSeq', () => ({
	nextShellTxSeq: (...args: unknown[]) => mockNextShellTxSeq(...args),
}))

import {
	clearPendingHomeMnemonicHandoff,
	isHomeHandoffDone,
	peekPendingHomeMnemonicHandoff,
	resetHomeBridgeHandoffForTests,
	runColdStartHomeHandoffOnce,
	setPendingHomeMnemonicHandoff,
} from './homeBridgeHandoff'

describe('homeBridgeHandoff', () => {
	beforeEach(() => {
		resetHomeBridgeHandoffForTests()
		jest.clearAllMocks()
		mockIsCashTreesNativeWebView.mockReturnValue(false)
		mockPwaWalletSyncTransportAvailable.mockReturnValue(true)
		mockSendPwaWalletSync.mockResolvedValue({ code: 'ok' })
		mockSendPwaWalletSyncCipher.mockResolvedValue({ code: 'ok' })
		mockNextShellTxSeq.mockReturnValue(42)
	})

	it('rejects invalid pending payloads', () => {
		setPendingHomeMnemonicHandoff({ eoa: 'not-an-address', phrase: PHRASE, tag: 't' })
		expect(peekPendingHomeMnemonicHandoff()).toBeNull()
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: 'too short', tag: 't' })
		expect(peekPendingHomeMnemonicHandoff()).toBeNull()
	})

	it('stores pending when valid; clears on clear', () => {
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: '@Demo' })
		expect(peekPendingHomeMnemonicHandoff()).toEqual({
			eoa: EOA,
			phrase: PHRASE,
			tag: 'Demo',
			passcode: undefined,
			seq: undefined,
		})
		clearPendingHomeMnemonicHandoff()
		expect(peekPendingHomeMnemonicHandoff()).toBeNull()
	})

	it('keeps six-digit passcode only', () => {
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x', passcode: '123456' })
		expect(peekPendingHomeMnemonicHandoff()?.passcode).toBe('123456')
		resetHomeBridgeHandoffForTests()
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x', passcode: 'longpassword' })
		expect(peekPendingHomeMnemonicHandoff()?.passcode).toBeUndefined()
	})

	it('browser: marks done and clears pending without sync', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(false)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('browser')
		expect(isHomeHandoffDone()).toBe(true)
		expect(peekPendingHomeMnemonicHandoff()).toBeNull()
		expect(mockSendPwaWalletSync).not.toHaveBeenCalled()
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('skipped')
	})

	it('shell with pending plaintext: sync ok then done', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('ok')
		expect(mockSendPwaWalletSync).toHaveBeenCalled()
		expect(isHomeHandoffDone()).toBe(true)
		expect(peekPendingHomeMnemonicHandoff()).toBeNull()
	})

	it('shell with six-digit passcode: allows seal failure as unavailable/retry without marking done', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x', passcode: '654321' })
		const r = await runColdStartHomeHandoffOnce()
		expect(['ok', 'unavailable', 'retry']).toContain(r)
		if (r !== 'ok') expect(isHomeHandoffDone()).toBe(false)
	})

	it('shell revisit without pending skips', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('skipped')
		expect(isHomeHandoffDone()).toBe(true)
	})

	// fix 2: after the shell accepts the handoff, the existing wallet-ready event starts the native chat in the same session.
	it('shell ok: notifies native wallet ready once (same-session chat start), with the tag and EOA', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: '@Demo' })
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('ok')
		expect(mockNotifyNativeWalletReady).toHaveBeenCalledTimes(1)
		expect(mockNotifyNativeWalletReady).toHaveBeenCalledWith('Demo', EOA)
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('skipped')
		expect(mockNotifyNativeWalletReady).toHaveBeenCalledTimes(1)
	})

	it('no wallet-ready event for browser, revisit, retry, unavailable', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(false)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		await runColdStartHomeHandoffOnce()
		resetHomeBridgeHandoffForTests()
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		await runColdStartHomeHandoffOnce() // revisit: no pending
		resetHomeBridgeHandoffForTests()
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		mockSendPwaWalletSync.mockResolvedValue({ code: 'write_failed' } as never)
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('retry')
		mockPwaWalletSyncTransportAvailable.mockReturnValue(false)
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('unavailable')
		expect(mockNotifyNativeWalletReady).not.toHaveBeenCalled()
	})

	it('a throwing wallet-ready notification does not turn a successful handoff into a failure', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		mockNotifyNativeWalletReady.mockImplementationOnce(() => {
			throw new Error('listener failed')
		})
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		await expect(runColdStartHomeHandoffOnce()).resolves.toBe('ok')
		expect(isHomeHandoffDone()).toBe(true)
	})

	it('concurrent calls join one attempt: one send, one result line', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		const [a, b] = await Promise.all([runColdStartHomeHandoffOnce(), runColdStartHomeHandoffOnce()])
		expect([a, b]).toEqual(['ok', 'ok'])
		expect(mockSendPwaWalletSync).toHaveBeenCalledTimes(1)
		expect(mockNotifyNativeWalletReady).toHaveBeenCalledTimes(1)
	})

	// fix 3: one entry line and one result line per attempt; only call number, stage, result, code, mode, seq.
	it('logs one enter and one result line per attempt, with no phrase, EOA or tag', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'SecretTagName' })
		await runColdStartHomeHandoffOnce()
		const lines = mockPublishNativePwaLog.mock.calls.map((c) => String(c[1]))
		expect(lines).toEqual([
			'[homeHandoff] enter n=1',
			'[homeHandoff] result n=1 result=ok stage=reply code=ok mode=plain seq=42',
		])
		const all = lines.join('\n')
		expect(all).not.toContain('abandon')
		expect(all.toLowerCase()).not.toContain(EOA.toLowerCase().slice(2, 10))
		expect(all).not.toContain('SecretTagName')
	})

	it('logs the failing stage and reply code for retry and unavailable', async () => {
		mockIsCashTreesNativeWebView.mockReturnValue(true)
		setPendingHomeMnemonicHandoff({ eoa: EOA, phrase: PHRASE, tag: 'x' })
		mockSendPwaWalletSync.mockResolvedValueOnce({ code: 'write_failed' } as never)
		await runColdStartHomeHandoffOnce()
		mockSendPwaWalletSync.mockResolvedValueOnce({ code: 'untrusted_source' } as never)
		await runColdStartHomeHandoffOnce()
		const lines = mockPublishNativePwaLog.mock.calls.map((c) => String(c[1]))
		expect(lines).toContain('[homeHandoff] result n=1 result=retry stage=reply code=write_failed mode=plain seq=42')
		expect(lines).toContain('[homeHandoff] result n=2 result=unavailable stage=reply code=untrusted_source mode=plain seq=42')
	})
})
