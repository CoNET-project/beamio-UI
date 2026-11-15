/**
 * Component regression for the passcode UI (flow table, tokens, messages). These are component tests in jsdom,
 * NOT a browser end-to-end run. The beamio module is mocked, so no storage, key or network is touched. SYNTHETIC values only.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as beamio from '../../services/beamio'
import * as nativeNfc from '../../utils/cashTreesNativeNfc'
import PasscodeLockScreen from '../PasscodeLockScreen'
import PasscodeSettingsSection from '../Setting/PasscodeSettingsSection'
import { CONFIRM_FORGET_TEXT, DONE_TEXT, MISMATCH_TEXT, POLICY_TEXT, WRONG_TEXT, backoffText } from '../../services/passcode/passcodeMessages'
import * as signOut from '../../services/signOutLocal'
import { PASSCODE_STATE_EVENT } from '../../services/walletVaultEvents'

jest.mock('../../services/beamio', () => ({
	unlockWalletVaultWithPasscode: jest.fn(),
	setWalletVaultPasscode: jest.fn(),
	disableWalletVaultPasscode: jest.fn(),
	walletVaultHasPasscode: jest.fn(),
	wipeLocalWalletForRestore: jest.fn(),
}))
jest.mock('../../utils/cashTreesNativeNfc', () => ({
	isCashTreesNativeWebView: jest.fn(() => false),
}))
jest.mock('../../services/signOutLocal', () => ({
	signOutLocalWallet: jest.fn(),
}))
// The real tu() loads i18next with the app resources; the test reads the English strings from the same file.
jest.mock('../../locale/beamioLocale', () => ({
	tu: (key: string) => (require('../../locale/en.json') as { ui: Record<string, string> }).ui[key] ?? key,
}))

const m = beamio as unknown as Record<string, jest.Mock>
const so = signOut as unknown as { signOutLocalWallet: jest.Mock }

/** Mirrors beamio.ts: a successful set, disable or wipe changes the stored state and dispatches PASSCODE_STATE_EVENT. */
const storeChanged = (on: boolean) => {
	m.walletVaultHasPasscode.mockResolvedValue(on)
	window.dispatchEvent(new Event(PASSCODE_STATE_EVENT))
}
const nat = nativeNfc as unknown as { isCashTreesNativeWebView: jest.Mock }

const GOOD = '12395784'
const GOOD2 = '24680246'
const WRONG = '13572468'

beforeEach(() => {
	m.unlockWalletVaultWithPasscode.mockReset()
	m.setWalletVaultPasscode.mockReset()
	m.disableWalletVaultPasscode.mockReset()
	m.walletVaultHasPasscode.mockReset()
	m.walletVaultHasPasscode.mockResolvedValue(false)
	nat.isCashTreesNativeWebView.mockReset()
	nat.isCashTreesNativeWebView.mockReturnValue(false)
	so.signOutLocalWallet.mockReset()
})

describe('lock screen (unlock flow)', () => {
	it('Unlock stays disabled until 8 digits are entered', () => {
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		const button = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
		expect(button.disabled).toBe(true)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: '1239578' } })
		expect(button.disabled).toBe(true)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: GOOD } })
		expect(button.disabled).toBe(false)
	})

	it('a correct passcode calls unlock once and then onUnlocked', async () => {
		m.unlockWalletVaultWithPasscode.mockResolvedValue({ ok: true })
		const onUnlocked = jest.fn()
		render(<PasscodeLockScreen onUnlocked={onUnlocked} />)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
		await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
		expect(m.unlockWalletVaultWithPasscode).toHaveBeenCalledWith(GOOD)
	})

	it('a wrong passcode shows the spec message and clears the input', async () => {
		m.unlockWalletVaultWithPasscode.mockResolvedValue({ ok: false, reason: 'wrong_passcode', retryAfterMs: 0, attempts: 1 })
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: WRONG } })
		fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(WRONG_TEXT)
		expect((screen.getByLabelText('Passcode') as HTMLInputElement).value).toBe('')
	})

	it('the fifth wrong try starts the cooldown: the spec message with mm:ss, and the button shows the countdown', async () => {
		m.unlockWalletVaultWithPasscode.mockResolvedValue({ ok: false, reason: 'wrong_passcode', retryAfterMs: 30_000, attempts: 5 })
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: WRONG } })
		fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(backoffText(30_000))
		expect(screen.getByRole('button', { name: /Try again in 00:30/ })).toBeDisabled()
	})

	it('a 6-digit entry is a format message; unlock is not called', () => {
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: '482915' } })
		// the button needs 8 digits, so the form cannot be submitted with 6: no call
		fireEvent.submit(screen.getByLabelText('Passcode').closest('form') as HTMLFormElement)
		expect(m.unlockWalletVaultWithPasscode).not.toHaveBeenCalled()
	})

	it('a storage error shows the generic error, not a detail', async () => {
		m.unlockWalletVaultWithPasscode.mockRejectedValue(new Error('io_init'))
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
		const alert = await screen.findByRole('alert')
		expect(alert).toHaveTextContent('Something went wrong. Your data was not changed.')
		expect(alert.textContent).not.toContain('io_init')
	})

	it('forgot passcode: delete stays disabled until the box is ticked', () => {
		render(<PasscodeLockScreen onUnlocked={() => undefined} />)
		fireEvent.click(screen.getByRole('button', { name: 'Forgot passcode?' }))
		const del = screen.getByRole('button', { name: 'Delete and re-import' }) as HTMLButtonElement
		expect(del.disabled).toBe(true)
		fireEvent.click(screen.getByRole('checkbox'))
		expect(del.disabled).toBe(false)
	})
})

describe('settings section (enable, change, disable flows)', () => {
	it('enable: a weak passcode shows the policy message and nothing is written', async () => {
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn on passcode' }))
		fireEvent.change(screen.getByLabelText('New passcode (8 to 12 digits)'), { target: { value: '12345678' } })
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(POLICY_TEXT.common)
		expect(m.setWalletVaultPasscode).not.toHaveBeenCalled()
	})

	it('enable: the forget warning must be ticked before the first step', async () => {
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn on passcode' }))
		fireEvent.change(screen.getByLabelText('New passcode (8 to 12 digits)'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(CONFIRM_FORGET_TEXT)
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(await screen.findByLabelText('Confirm passcode')).toBeInTheDocument()
	})

	it('enable: a mismatch goes back to the new-passcode step with the mismatch message', async () => {
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn on passcode' }))
		fireEvent.change(screen.getByLabelText('New passcode (8 to 12 digits)'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		fireEvent.change(await screen.findByLabelText('Confirm passcode'), { target: { value: GOOD2 } })
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(MISMATCH_TEXT)
		expect(screen.getByLabelText('New passcode (8 to 12 digits)')).toBeInTheDocument()
		expect(m.setWalletVaultPasscode).not.toHaveBeenCalled()
	})

	it('enable: a matching confirmation writes once and shows the done text; the status reads On', async () => {
		m.setWalletVaultPasscode.mockImplementation(async () => {
			storeChanged(true)
			return { ok: true }
		})
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn on passcode' }))
		fireEvent.change(screen.getByLabelText('New passcode (8 to 12 digits)'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		fireEvent.change(await screen.findByLabelText('Confirm passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
		expect(await screen.findByRole('status')).toHaveTextContent(DONE_TEXT.enable)
		expect(m.setWalletVaultPasscode).toHaveBeenCalledTimes(1)
		expect(m.setWalletVaultPasscode).toHaveBeenCalledWith(GOOD)
		expect(screen.getByText('On')).toBeInTheDocument()
	})

	it('change: a wrong old passcode stays in the verify step; the right one leads to the new passcode', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(true)
		m.unlockWalletVaultWithPasscode.mockResolvedValueOnce({ ok: false, reason: 'wrong_passcode', retryAfterMs: 0, attempts: 1 })
		m.unlockWalletVaultWithPasscode.mockResolvedValueOnce({ ok: true })
		m.setWalletVaultPasscode.mockResolvedValue({ ok: true })
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Change passcode' }))
		fireEvent.change(screen.getByLabelText('Current passcode'), { target: { value: WRONG } })
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(await screen.findByRole('alert')).toHaveTextContent(WRONG_TEXT)
		expect(screen.getByLabelText('Current passcode')).toBeInTheDocument()
		fireEvent.change(screen.getByLabelText('Current passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		fireEvent.change(await screen.findByLabelText(/New passcode/), { target: { value: GOOD2 } })
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		fireEvent.change(await screen.findByLabelText('Confirm passcode'), { target: { value: GOOD2 } })
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
		expect(await screen.findByRole('status')).toHaveTextContent(DONE_TEXT.change)
		expect(m.setWalletVaultPasscode).toHaveBeenCalledWith(GOOD2)
	})

	it('turn off: the passcode is checked, the forget box ticked, then the status reads Off', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(true)
		m.disableWalletVaultPasscode.mockImplementation(async () => {
			storeChanged(false)
			return { ok: true }
		})
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
		fireEvent.change(screen.getByLabelText('Current passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(await screen.findByRole('status')).toHaveTextContent(DONE_TEXT.disable)
		expect(m.disableWalletVaultPasscode).toHaveBeenCalledWith(GOOD)
		expect(screen.getByText('Off')).toBeInTheDocument()
	})

	it('in the native shell the section shows the explanation only: no passcode input and no buttons', async () => {
		nat.isCashTreesNativeWebView.mockReturnValue(true)
		const { container } = render(<PasscodeSettingsSection />)
		expect(within(container).queryByRole('button')).toBeNull()
		expect(within(container).queryByLabelText(/passcode/i)).toBeNull()
		expect(container).toHaveTextContent('system keystore')
		expect(m.walletVaultHasPasscode).not.toHaveBeenCalled()
	})

	it('the policy texts are the spec drafts (spot check)', () => {
		expect(POLICY_TEXT.too_short).toBe('Use 8 to 12 digits.')
		expect(POLICY_TEXT.sequence).toBe('Do not use six digits in a row.')
	})
})

describe('sign-out entry ("Lock"): shown only while a passcode is on', () => {
	it('no passcode: the entry is not rendered at all (no button, not disabled, not greyed)', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(false)
		render(<PasscodeSettingsSection />)
		expect(await screen.findByText('Off')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull()
		expect(screen.queryByText('Lock')).toBeNull()
	})

	it('passcode on: the Lock entry is rendered and a tap runs the sign-out once', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(true)
		render(<PasscodeSettingsSection />)
		const lock = await screen.findByRole('button', { name: 'Lock' })
		expect((lock as HTMLButtonElement).disabled).toBe(false)
		fireEvent.click(lock)
		expect(so.signOutLocalWallet).toHaveBeenCalledTimes(1)
	})

	it('passcode on, but the cooldown is running: the Lock entry stays available (it is not a passcode operation)', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(true)
		m.unlockWalletVaultWithPasscode.mockResolvedValue({ ok: false, reason: 'backoff', retryAfterMs: 30_000, attempts: 5 })
		render(<PasscodeSettingsSection />)
		fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
		fireEvent.change(screen.getByLabelText('Current passcode'), { target: { value: WRONG } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('alert')
		// The flow is in progress; the entry is shown and works even while a cooldown runs.
		expect(screen.getByRole('button', { name: 'Lock' })).toBeInTheDocument()
	})

	it('enable: the Lock entry appears at once after a successful set (no reload)', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(false)
		m.setWalletVaultPasscode.mockImplementation(async () => {
			storeChanged(true)
			return { ok: true }
		})
		render(<PasscodeSettingsSection />)
		expect(await screen.findByText('Off')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: 'Turn on passcode' }))
		fireEvent.change(screen.getByLabelText('New passcode (8 to 12 digits)'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		fireEvent.change(await screen.findByLabelText('Confirm passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
		expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument()
		expect(screen.getByText('On')).toBeInTheDocument()
	})

	it('turn off: the Lock entry disappears at once after the passcode is removed', async () => {
		m.walletVaultHasPasscode.mockResolvedValue(true)
		m.disableWalletVaultPasscode.mockImplementation(async () => {
			storeChanged(false)
			return { ok: true }
		})
		render(<PasscodeSettingsSection />)
		expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
		fireEvent.change(screen.getByLabelText('Current passcode'), { target: { value: GOOD } })
		fireEvent.click(screen.getByRole('checkbox'))
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(await screen.findByRole('status')).toHaveTextContent(DONE_TEXT.disable)
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull())
		fireEvent.click(screen.getByRole('button', { name: 'Close' }))
		expect(await screen.findByRole('button', { name: 'Turn on passcode' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull()
	})
})
