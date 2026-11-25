/**
 * Create-account failure messages (side finding): the error of THIS attempt is shown, every time. A failed attempt used to leave the
 * form with no message on the second try, because the failure branch read the previous render's error state. Browser and shell branches.
 * SYNTHETIC values only; the network, the native bridge and the workers are stubs; no request is made.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as never
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

let mockShellMode = false
jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/services/beamio', () => {
	class LocalCreateError extends Error {
		step: string
		constructor(stepName: string) {
			super(stepName)
			this.step = stepName
		}
	}
	class CreateRemoteError extends Error {
		kind: 'network' | 'http'
		status?: number
		constructor(kindName: 'network' | 'http', httpStatus?: number) {
			super(kindName)
			this.kind = kindName
			this.status = httpStatus
		}
	}
	return { checkBeamioAccountAPI: jest.fn(async () => true), createRecover: jest.fn(), LocalCreateError, CreateRemoteError }
})
jest.mock('@/services/nativeRecovery', () => ({
	nativeAccountCreateOpen: jest.fn(),
	nativeRecoveryOpen: jest.fn(),
	onNativeAccountCreateResult: () => () => undefined,
	onNativeRecoveryResult: () => () => undefined,
	recoveryOpenErrorKey: () => '',
}))
jest.mock('@/services/nativeWallet', () => ({ notifyNativeWalletReady: jest.fn(), reachNativeWallet: jest.fn(), rememberNativeEoa: jest.fn() }))
jest.mock('@/services/nativeWalletEstablished', () => ({ announceNativeWalletEstablished: jest.fn() }))
jest.mock('@/services/nativeFlowPending', () => ({ announceNativeFlowPending: jest.fn() }))
jest.mock('@/services/shellChatCapability', () => ({ ensureShellChatState: jest.fn(async () => 'native_chat') }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => mockShellMode }))
jest.mock('@/services/argon2WorkerBridge', () => ({ warmArgon2Worker: jest.fn() }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./RecoveryQRScreen', () => ({ getActivatingSteps: () => [] }))
jest.mock('./VerraFloatingNavChrome', () => ({ VerraFloatingNavChrome: () => null }))
jest.mock('@/components/IpfsImg', () => ({ IpfsImg: () => null }))
jest.mock('@/components/InvitedByIntroducerChip', () => ({ InvitedByIntroducerChip: () => null }))

const CreateUsernamePinScreen = require('./CreateUsernamePinScreen').default
const beamio = require('@/services/beamio')
const nativeRecovery = require('@/services/nativeRecovery')
const shellChatCapability = require('@/services/shellChatCapability')

const TAG = 'synthtag01'
const PWD = 'Abcdefg1'
const CREATED = { qrCode: 'data:image/png;base64,AAAA', recoverCode: 'SYNTH-CODE', temp: { profiles: [{ keyID: '0x1111111111111111111111111111111111111111' }] } }

const fill = async (close: jest.Mock) => {
	render(<CreateUsernamePinScreen close={close} />)
	const tag = document.getElementById('create-beamio-tag-input') as HTMLInputElement
	fireEvent.change(tag, { target: { value: TAG } })
	if (!mockShellMode) fireEvent.change(document.getElementById('create-wallet-password') as HTMLInputElement, { target: { value: PWD } })
	fireEvent.click(screen.getByRole('checkbox'))
	fireEvent.blur(tag)
	// the form is replaced by the loading screen while a create runs, so the button is looked up again for every press
	const nextButton = () => screen.getByText('next').closest('button') as HTMLButtonElement
	await waitFor(() => expect(nextButton().disabled).toBe(false), { timeout: 5000 })
	return () => {
		fireEvent.click(nextButton())
	}
}

beforeEach(() => {
	jest.clearAllMocks()
	// the test runner resets mock implementations before each test: they are set again here
	beamio.checkBeamioAccountAPI.mockImplementation(async () => true)
	shellChatCapability.ensureShellChatState.mockImplementation(async () => 'native_chat')
})

describe('browser branch: every failed attempt shows its error', () => {
	beforeEach(() => {
		mockShellMode = false
	})

	it('two failures in a row that both return null (no thrown reason): the message shows after each, never nothing on the second', async () => {
		beamio.createRecover.mockResolvedValue(null)
		const close = jest.fn()
		const press = await fill(close)
		press()
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		// the second attempt clears the message while it runs, then shows it again
		await waitFor(() => expect((screen.getByText('next').closest('button') as HTMLButtonElement).disabled).toBe(false))
		press()
		await waitFor(() => expect(beamio.createRecover).toHaveBeenCalledTimes(2), { timeout: 5000 })
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		expect(close).not.toHaveBeenCalled()
	})

	it('a network failure and a server answer are different messages, both visible on repeated failures', async () => {
		beamio.createRecover
			.mockRejectedValueOnce(new beamio.CreateRemoteError('network'))
			.mockRejectedValueOnce(new beamio.CreateRemoteError('network'))
			.mockRejectedValueOnce(new beamio.CreateRemoteError('http', 503))
		const close = jest.fn()
		const press = await fill(close)
		press()
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		press()
		await waitFor(() => expect(beamio.createRecover).toHaveBeenCalledTimes(2), { timeout: 5000 })
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		await waitFor(() => expect((screen.getByText('next').closest('button') as HTMLButtonElement).disabled).toBe(false))
		press()
		await waitFor(() => expect(beamio.createRecover).toHaveBeenCalledTimes(3), { timeout: 5000 })
		expect(await screen.findByText('create_account_try_later')).toBeTruthy()
		expect(screen.queryByText('network_error_try_again')).toBeNull()
		expect(close).not.toHaveBeenCalled()
	})

	it('a local failure keeps its own message (the specific reason is not overwritten by the generic one)', async () => {
		beamio.createRecover.mockRejectedValueOnce(new beamio.LocalCreateError('mnemonic_missing'))
		const close = jest.fn()
		const press = await fill(close)
		press()
		expect(await screen.findByText('create_account_mnemonic_missing')).toBeTruthy()
		expect(screen.queryByText('network_error_try_again')).toBeNull()
	})

	it('0.53.48.1: a registered account whose local save failed still closes with the recovery code and tells the user to save it', async () => {
		const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined)
		beamio.createRecover.mockResolvedValueOnce({ ...CREATED, persistFailed: true })
		const close = jest.fn()
		const press = await fill(close)
		press()
		await waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(close.mock.calls[0][0]).toMatchObject({ beamioTag: TAG, passcode: 'SYNTH-CODE' })
		expect(alertSpy).toHaveBeenCalledWith('create_account_registered_save_code')
		expect(screen.queryByText('create_account_local_error')).toBeNull()
		alertSpy.mockRestore()
	})

	it('a normal success shows no such notice', async () => {
		const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined)
		beamio.createRecover.mockResolvedValueOnce(CREATED)
		const close = jest.fn()
		const press = await fill(close)
		press()
		await waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(alertSpy).not.toHaveBeenCalled()
		alertSpy.mockRestore()
	})

	it('a failure and then a success: the error is gone and the flow closes with the created account', async () => {
		beamio.createRecover.mockResolvedValueOnce(null).mockResolvedValueOnce(CREATED)
		const close = jest.fn()
		const press = await fill(close)
		press()
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		await waitFor(() => expect((screen.getByText('next').closest('button') as HTMLButtonElement).disabled).toBe(false))
		press()
		await waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(screen.queryByText('network_error_try_again')).toBeNull()
		expect(close.mock.calls[0][0]).toMatchObject({ beamioTag: TAG, passcode: 'SYNTH-CODE' })
	})
})

describe('shell branch: every refused open shows its message', () => {
	beforeEach(() => {
		mockShellMode = true
	})

	it('two refusals in a row (not_ready): the message shows after each; then an accepted open clears it', async () => {
		nativeRecovery.nativeAccountCreateOpen
			.mockResolvedValueOnce({ ok: false, reason: 'not_ready' })
			.mockResolvedValueOnce({ ok: false, reason: 'not_ready' })
			.mockResolvedValueOnce({ ok: true, page: 'opened' })
		const close = jest.fn()
		const press = await fill(close)
		press()
		expect(await screen.findByText('create_account_try_later', {}, { timeout: 5000 })).toBeTruthy()
		await waitFor(() => expect((screen.getByText('next').closest('button') as HTMLButtonElement).disabled).toBe(false))
		press()
		await waitFor(() => expect(nativeRecovery.nativeAccountCreateOpen).toHaveBeenCalledTimes(2), { timeout: 5000 })
		expect(await screen.findByText('create_account_try_later', {}, { timeout: 5000 })).toBeTruthy()
		await waitFor(() => expect((screen.getByText('next').closest('button') as HTMLButtonElement).disabled).toBe(false))
		press()
		await waitFor(() => expect(nativeRecovery.nativeAccountCreateOpen).toHaveBeenCalledTimes(3), { timeout: 5000 })
		await waitFor(() => expect(screen.queryByText('create_account_try_later')).toBeNull(), { timeout: 5000 })
		expect(beamio.createRecover).not.toHaveBeenCalled() // the shell never generates a key in the page
		expect(close).not.toHaveBeenCalled()
	})
})
