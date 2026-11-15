/**
 * Device-key save: a synchronous throw inside the IndexedDB success callback (for example DataCloneError from put) must reject the
 * Promise. Before the fix it never settled, and the page waited forever (ACCT-NE, walletWrap put hang). Runtime test with a fake
 * indexedDB; no real storage.
 */
import { VaultError, indexedDbDeviceKeyStore } from './walletWrap'

describe('device-key save never hangs when put throws synchronously', () => {
	const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB

	afterEach(() => {
		;(globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB
	})

	it('rejects with device_store_write when the transaction or put throws', async () => {
		const close = jest.fn()
		const db = {
			transaction: () => {
				throw new Error('DataCloneError: simulated')
			},
			close,
		}
		;(globalThis as { indexedDB?: unknown }).indexedDB = {
			open: () => {
				const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void } = {}
				setTimeout(() => {
					req.result = db
					req.onsuccess?.()
				}, 0)
				return req
			},
		}
		const store = indexedDbDeviceKeyStore()
		const settled = store.save({} as CryptoKey)
		const hang = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still pending (hang)')), 1000))
		await expect(Promise.race([settled, hang])).rejects.toBeInstanceOf(VaultError)
		expect(close).toHaveBeenCalled()
	})
})
