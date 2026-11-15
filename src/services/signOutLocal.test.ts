/**
 * Sign-out ("Lock") order and event. The chat library and the wallet layer are mocked; SYNTHETIC values only.
 */
import * as beamio from './beamio'
import * as chatLocal from './chatLocalMigration'
import { signOutLocalWallet } from './signOutLocal'
import { VAULT_LOCKED_EVENT } from './walletVaultEvents'

jest.mock('./beamio', () => ({
	lockWalletVaultOnLogout: jest.fn(),
}))
jest.mock('./chatLocalMigration', () => ({
	lockChatLocalOnLogout: jest.fn(),
}))

const b = beamio as unknown as { lockWalletVaultOnLogout: jest.Mock }
const c = chatLocal as unknown as { lockChatLocalOnLogout: jest.Mock }

beforeEach(() => {
	b.lockWalletVaultOnLogout.mockReset()
	c.lockChatLocalOnLogout.mockReset()
	c.lockChatLocalOnLogout.mockResolvedValue(undefined)
})

describe('signOutLocalWallet', () => {
	it('locks the chat library first, then the wallet layer; with a passcode on it signals the gate once', async () => {
		b.lockWalletVaultOnLogout.mockResolvedValue(true)
		const onLocked = jest.fn()
		window.addEventListener(VAULT_LOCKED_EVENT, onLocked)
		try {
			await signOutLocalWallet()
		} finally {
			window.removeEventListener(VAULT_LOCKED_EVENT, onLocked)
		}
		expect(c.lockChatLocalOnLogout).toHaveBeenCalledTimes(1)
		expect(b.lockWalletVaultOnLogout).toHaveBeenCalledTimes(1)
		expect(c.lockChatLocalOnLogout.mock.invocationCallOrder[0]).toBeLessThan(b.lockWalletVaultOnLogout.mock.invocationCallOrder[0])
		expect(onLocked).toHaveBeenCalledTimes(1)
	})

	it('without a passcode the chat library is still locked, but the gate is not signalled', async () => {
		b.lockWalletVaultOnLogout.mockResolvedValue(false)
		const onLocked = jest.fn()
		window.addEventListener(VAULT_LOCKED_EVENT, onLocked)
		try {
			await signOutLocalWallet()
		} finally {
			window.removeEventListener(VAULT_LOCKED_EVENT, onLocked)
		}
		expect(c.lockChatLocalOnLogout).toHaveBeenCalledTimes(1)
		expect(onLocked).not.toHaveBeenCalled()
	})
})
