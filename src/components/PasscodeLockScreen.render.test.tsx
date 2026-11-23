/**
 * R-16 render check: a native-side lock hides "Forgot passcode?"; the page lock shows it.
 */
import { render, screen } from '@testing-library/react'
import PasscodeLockScreen from './PasscodeLockScreen'

jest.mock('../services/beamio', () => ({
	unlockWalletVaultWithPasscode: jest.fn(),
	wipeLocalWalletForRestore: jest.fn(),
}))

describe('R-16 render: forgot-passcode by lock kind', () => {
	it('shows "Forgot passcode?" for the page lock (default)', () => {
		render(<PasscodeLockScreen onUnlocked={() => {}} />)
		expect(screen.getByText('Forgot passcode?')).toBeTruthy()
	})

	it('shows "Forgot passcode?" for the explicit page lock', () => {
		render(<PasscodeLockScreen lock="page" onUnlocked={() => {}} />)
		expect(screen.getByText('Forgot passcode?')).toBeTruthy()
	})

	it('hides "Forgot passcode?" for a native lock', () => {
		render(<PasscodeLockScreen lock="native" onUnlocked={() => {}} />)
		expect(screen.queryByText('Forgot passcode?')).toBeNull()
	})
})
