/**
 * Repro, caller side: the vault's verification and passcode-state reads do not move the page's copy basis; they go
 * through the probe read when the store has one. The unlock read, which builds the page copy, keeps the baseline read.
 */
import { passcodeEnabled, readPlainForVerify, unlockWalletPasscode, type WalletStores } from './walletVault'

const storeWith = (readInit: jest.Mock, probeInit: jest.Mock): WalletStores => ({ readInit, probeInit } as unknown as WalletStores)

describe('verification reads use the probe in the shell', () => {
	it('readPlainForVerify reads through the probe, not the baseline read', async () => {
		const readInit = jest.fn(async () => ({ stale: true }))
		const probeInit = jest.fn(async () => null)
		expect(await readPlainForVerify(storeWith(readInit, probeInit))).toBeNull()
		expect(probeInit).toHaveBeenCalledTimes(1)
		expect(readInit).not.toHaveBeenCalled()
	})

	it('passcodeEnabled reads through the probe, not the baseline read', async () => {
		const readInit = jest.fn(async () => ({ stale: true }))
		const probeInit = jest.fn(async () => ({}))
		expect(await passcodeEnabled(storeWith(readInit, probeInit))).toBe(false)
		expect(probeInit).toHaveBeenCalledTimes(1)
		expect(readInit).not.toHaveBeenCalled()
	})

	it('the passcode unlock reads through the probe, not the baseline read', async () => {
		const readInit = jest.fn(async () => ({ stale: true }))
		const probeInit = jest.fn(async () => null)
		const s = { readInit, probeInit, readMeta: async () => ({ failures: 0, nextAt: 0 }) } as unknown as WalletStores
		await unlockWalletPasscode(s, '12395784')
		expect(probeInit).toHaveBeenCalledTimes(1)
		expect(readInit).not.toHaveBeenCalled()
	})
})

