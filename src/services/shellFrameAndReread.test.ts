/**
 * Review a (2026-11-17): after a failed write the page re-reads the native state with walletEoaAddress (no secret) and never with
 * nativeMnemonicPreread; the page-to-shell commands that carry a phrase or a pre-read are for the trusted top frame only. SYNTHETIC values only.
 */
const mockPreread = jest.fn(async () => 'valid' as const)
jest.mock('./pwaWalletSyncTransport', () => ({
	sendNativeMnemonicPreread: (...a: unknown[]) => (mockPreread as unknown as (...x: unknown[]) => unknown)(...a),
	sendPwaWalletSync: jest.fn(async () => ({ code: 'ok' })),
	pwaWalletSyncTransportAvailable: () => true,
}))
const mockReadEoa = jest.fn()
jest.mock('./walletEoaAddress', () => ({
	readWalletEoaAddress: (...a: unknown[]) => (mockReadEoa as unknown as (...x: unknown[]) => unknown)(...a),
}))

import { rereadNativeAccountState } from './shellMnemonicSync'
import { sendShellWalletSyncCommand, sendWindowOnlyCommand } from './shellRecordTransport'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('the re-read after a failed write never uses nativeMnemonicPreread (review a)', () => {
	beforeEach(() => {
		mockPreread.mockClear()
		mockReadEoa.mockReset()
	})
	it('an address answer is valid, and the pre-read command is not sent', async () => {
		mockReadEoa.mockResolvedValueOnce({ kind: 'address', eoa: EOA })
		expect(await rereadNativeAccountState()).toBe('valid')
		expect(mockReadEoa).toHaveBeenCalledTimes(1)
		expect(mockPreread).not.toHaveBeenCalled()
	})
	it('a no_key refusal is absent (the same as no key), and the pre-read command is not sent', async () => {
		mockReadEoa.mockResolvedValueOnce({ kind: 'refused', code: 'no_key' })
		expect(await rereadNativeAccountState()).toBe('absent')
		expect(mockPreread).not.toHaveBeenCalled()
	})
	it('a timeout or any other refusal is unknown (held), and the pre-read command is not sent', async () => {
		mockReadEoa.mockResolvedValueOnce({ kind: 'refused', code: 'timeout' })
		expect(await rereadNativeAccountState()).toBe('unknown')
		mockReadEoa.mockRejectedValueOnce(new Error('bridge down'))
		expect(await rereadNativeAccountState()).toBe('unknown')
		expect(mockPreread).not.toHaveBeenCalled()
	})
})

describe('the page-to-shell commands are for the trusted top frame only (defence in depth)', () => {
	const realTop = window.top
	let postMessage: jest.Mock
	beforeEach(() => {
		postMessage = jest.fn()
		;(window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord = {
			allowedOrigins: [window.location.origin],
			onmessage: null,
			postMessage,
		}
	})
	afterEach(() => {
		Object.defineProperty(window, 'top', { value: realTop, configurable: true })
		delete (window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord
	})
	it('in a child frame, pwaWalletSync and nativeMnemonicPreread are not sent', async () => {
		Object.defineProperty(window, 'top', { value: {}, configurable: true })
		const a = await sendShellWalletSyncCommand({ type: 'pwaWalletSync', reqId: 1, eoa: EOA, phrase: 'x', seq: 1 }, 50)
		const b = await sendShellWalletSyncCommand({ type: 'nativeMnemonicPreread', reqId: 2, seq: 1 }, 50)
		expect(a.kind).toBe('unavailable')
		expect(b.kind).toBe('unavailable')
		expect(postMessage).not.toHaveBeenCalled()
	})
	it('in a child frame, the window-only commands (walletEoaAddress, walletCredential) are not sent', async () => {
		Object.defineProperty(window, 'top', { value: {}, configurable: true })
		const a = await sendWindowOnlyCommand({ type: 'walletEoaAddress', reqId: 3 }, 50)
		expect(a.kind).toBe('unavailable')
		expect(postMessage).not.toHaveBeenCalled()
	})
	it('in the top frame, the same command is sent (the gate does not block the trusted page)', () => {
		Object.defineProperty(window, 'top', { value: window, configurable: true })
		void sendShellWalletSyncCommand({ type: 'pwaWalletSync', reqId: 4, eoa: EOA, phrase: 'x', seq: 1 }, 20)
		expect(postMessage).toHaveBeenCalledTimes(1)
	})
})

describe('static pin: the sync module never calls nativeMnemonicPreread (review a)', () => {
	it('shellMnemonicSync.ts has no call to sendNativeMnemonicPreread', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'shellMnemonicSync.ts'), 'utf8') as string
		expect(src).not.toMatch(/sendNativeMnemonicPreread\s*\(/)
	})
})
