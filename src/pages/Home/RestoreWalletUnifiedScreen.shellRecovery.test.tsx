/**
 * 0.53.49 (plan A, P1): the restore page in a shell, real component, simulated shell replies. The page shows the PWA screens, hands the
 * credential to the engine (nativeRecoverySubmit), clears its state at once whatever the outcome, shows PWA copy for each result code,
 * and never calls the in-page restore. The shells are not built yet: every shell answer here is simulated.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as unknown as MediaQueryList)
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { restoreWithRedeemDetailed, restoreWithUserPin } from '@/services/beamio'
import * as nr from '@/services/nativeRecovery'
import { notifyNativeWalletReady, rememberNativeEoa, reachNativeWallet } from '@/services/nativeWallet'

jest.mock('@/locale/beamioLocale', () => ({
	...jest.requireActual('@/locale/beamioLocale'),
	tu: (key: string, o?: Record<string, unknown>) => (o ? `${key}|${JSON.stringify(o)}` : key),
	useTu: () => ({ tu: (key: string, o?: Record<string, unknown>) => (o ? `${key}|${JSON.stringify(o)}` : key), locale: 'en' }),
}))
jest.mock('@/services/beamio', () => ({
	onWalletEvent: (name: string, cb: (v: string) => void) => {
		if (name === 'scan:url') (globalThis as { __scanUrl?: (v: string) => void }).__scanUrl = cb
		return () => undefined
	},
	restoreWithRedeemDetailed: jest.fn(),
	restoreWithUserPin: jest.fn(),
}))
jest.mock('@/services/nativeRecovery', () => ({
	nativeRecoveryCopyKey: jest.requireActual('@/services/nativeRecovery').nativeRecoveryCopyKey,
	recoveryOpenErrorKey: jest.requireActual('@/services/nativeRecovery').recoveryOpenErrorKey,
	nativeRecoveryOpen: jest.fn(),
	nativeRecoverySubmit: jest.fn(),
	nativeRecoveryCancel: jest.fn(),
	hasPageInputRecovery: jest.fn(),
	isTopFrameForRecovery: jest.fn(),
	isTrustedRecoveryOrigin: jest.fn(),
	onNativeRecoveryResult: jest.fn(),
}))
jest.mock('@/services/nativeWallet', () => ({ notifyNativeWalletReady: jest.fn(), rememberNativeEoa: jest.fn(), reachNativeWallet: jest.fn() }))
jest.mock('@/services/nativeWalletEstablished', () => ({ announceNativeWalletEstablished: jest.fn() }))
jest.mock('@/services/nativeFlowPending', () => ({ announceNativeFlowPending: jest.fn() }))
jest.mock('@/services/argon2WorkerBridge', () => ({ warmArgon2Worker: jest.fn() }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ getCashTreesNativeNfcBridge: () => null, getCashTreesNativeNfcHost: () => (globalThis as { __host?: string }).__host ?? 'android' }))
jest.mock('./RecoveryQrScanPanel', () => (props: { onCode: (c: string) => void }) => {
	;(globalThis as { __panelOnCode?: (c: string) => void }).__panelOnCode = props.onCode
	return null
})
jest.mock('./VerraFloatingNavChrome', () => ({ VerraFloatingNavChrome: (p: { onBack: () => void }) => <button type="button" aria-label="back" onClick={p.onBack} /> }))

const RestoreWalletUnifiedScreen = require('./RestoreWalletUnifiedScreen').default

const open = nr.nativeRecoveryOpen as jest.Mock
const submit = nr.nativeRecoverySubmit as jest.Mock
const cancel = nr.nativeRecoveryCancel as jest.Mock
const hasCap = nr.hasPageInputRecovery as jest.Mock
const topFrame = nr.isTopFrameForRecovery as jest.Mock
const trusted = nr.isTrustedRecoveryOrigin as jest.Mock
const onResult = nr.onNativeRecoveryResult as jest.Mock

const CODE = 'a1B2c3D4e5F6g7H8i9J0kL'
const PASSWORD = 'canary-Passw0rd'
let emit: (r: { code: string; eoa?: string; cooldownSec?: number }) => void

beforeEach(() => {
	;(globalThis as { __host?: string }).__host = 'android'
	topFrame.mockReturnValue(true)
	trusted.mockReturnValue(true)
	hasCap.mockResolvedValue(true)
	open.mockResolvedValue({ ok: true })
	submit.mockResolvedValue({ ok: true })
	cancel.mockResolvedValue({ ok: true })
	;(reachNativeWallet as jest.Mock).mockResolvedValue(undefined)
	onResult.mockImplementation((cb: typeof emit) => {
		emit = cb
		return () => undefined
	})
})

const mount = async (props: Record<string, unknown> = {}) => {
	const onClose = jest.fn()
	render(<RestoreWalletUnifiedScreen onClose={onClose} onRestore={jest.fn()} {...props} />)
	await waitFor(() => expect(screen.getByPlaceholderText('yourtag')).toBeTruthy())
	return { onClose }
}
const fillLogin = () => {
	fireEvent.change(screen.getByPlaceholderText('yourtag'), { target: { value: 'synthtag' } })
	fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: PASSWORD } })
}
const submitLogin = async () => {
	await act(async () => {
		fireEvent.submit(screen.getByPlaceholderText('yourtag').closest('form') as HTMLFormElement)
	})
}
const goRecovery = () => fireEvent.click(screen.getAllByRole('button', { name: 'use_recovery_code' })[0])
const codeBox = () => screen.getByPlaceholderText('enter_or_paste_your_code') as HTMLInputElement
const submitCode = async () => {
	await act(async () => {
		fireEvent.submit(codeBox().closest('form') as HTMLFormElement)
	})
}

describe('shell: the PWA login screen is shown directly', () => {
	it('shows the login screen with no intermediate native entry, and offers the recovery code screen', async () => {
		await mount()
		expect(screen.getByText('unlock_your_beamio_id')).toBeTruthy()
		expect(screen.getByPlaceholderText('••••••••••••')).toBeTruthy()
		goRecovery()
		expect(codeBox()).toBeTruthy()
		expect(open).not.toHaveBeenCalled()
		expect(submit).not.toHaveBeenCalled()
	})

	it('prefills the BeamioTag', async () => {
		await mount({ initialBeamioTag: 'Synthtag' })
		expect((screen.getByPlaceholderText('yourtag') as HTMLInputElement).value.toLowerCase()).toBe('synthtag')
	})
})

describe('shell: account name and password', () => {
	it('opens the session, submits exactly the account request, clears the password at once, and never restores in the page', async () => {
		await mount()
		fillLogin()
		let sentPassword = ''
		submit.mockImplementation(async (p: { password?: string }) => {
			sentPassword = p.password ?? ''
			// the page state is already cleared when the request goes out: the loading screen replaced the form
			return { ok: true }
		})
		await submitLogin()
		expect(open).toHaveBeenCalledTimes(1)
		expect(submit).toHaveBeenCalledWith({ path: 'account', name: 'synthtag', password: PASSWORD })
		expect(sentPassword).toBe(PASSWORD)
		expect(restoreWithUserPin).not.toHaveBeenCalled()
		expect(restoreWithRedeemDetailed).not.toHaveBeenCalled()
		// a result brings the form back; the password field is empty (cleared when the request was built)
		await act(async () => emit({ code: 'bad_pin' }))
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).value).toBe('')
		expect(document.body.textContent).not.toContain(PASSWORD)
	})

	it('a short password is refused by the page and nothing is sent or cleared', async () => {
		await mount()
		fireEvent.change(screen.getByPlaceholderText('yourtag'), { target: { value: 'synthtag' } })
		fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: '123' } })
		await submitLogin()
		expect(open).not.toHaveBeenCalled()
		expect(submit).not.toHaveBeenCalled()
		expect(screen.getByText('password_must_be_at_least_6_characters')).toBeTruthy()
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).value).toBe('123')
	})

	it('a retry after a wrong password reuses the open session', async () => {
		await mount()
		fillLogin()
		await submitLogin()
		await act(async () => emit({ code: 'bad_pin' }))
		expect(screen.getByText('recovery.native.bad_pin')).toBeTruthy()
		fillLogin()
		await submitLogin()
		expect(open).toHaveBeenCalledTimes(1)
		expect(submit).toHaveBeenCalledTimes(2)
	})

	it('ok enters the app without a reload: wallet established, EOA remembered, wallet ready announced', async () => {
		await mount({ initialBeamioTag: 'synthtag' })
		fillLogin()
		await submitLogin()
		await act(async () => emit({ code: 'ok', eoa: '0x' + '1'.repeat(40) }))
		expect(rememberNativeEoa).toHaveBeenCalledWith('0x' + '1'.repeat(40))
		await waitFor(() => expect(notifyNativeWalletReady).toHaveBeenCalled())
		expect(cancel).not.toHaveBeenCalled()
	})
})

describe('shell: recovery code', () => {
	it('submits only the code request and clears the box at once', async () => {
		await mount()
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: CODE } })
		await submitCode()
		expect(open).toHaveBeenCalledTimes(1)
		expect(submit).toHaveBeenCalledWith({ path: 'code', code: CODE })
		expect(codeBox().value).toBe('')
		expect(restoreWithRedeemDetailed).not.toHaveBeenCalled()
	})

	it('a malformed code (and a URL) is refused by the page before anything is sent', async () => {
		await mount()
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: 'not a code' } })
		await submitCode()
		expect(screen.getByText('invalid_recovery_code_format')).toBeTruthy()
		fireEvent.change(codeBox(), { target: { value: 'https://example.invalid/x' } })
		await submitCode()
		expect(open).not.toHaveBeenCalled()
		expect(submit).not.toHaveBeenCalled()
	})

	it('a scanned code in the right format fills the box in a shell; a mnemonic does not', async () => {
		await mount()
		goRecovery()
		act(() => (globalThis as { __scanUrl?: (v: string) => void }).__scanUrl?.(CODE))
		expect(codeBox().value).toBe(CODE)
		fireEvent.change(codeBox(), { target: { value: '' } })
		act(() => (globalThis as { __scanUrl?: (v: string) => void }).__scanUrl?.('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'))
		expect(codeBox().value).toBe('')
		expect(screen.getByText('invalid_recovery_code_format')).toBeTruthy()
	})

	it('the camera scan panel returns to the recovery screen with the code filled', async () => {
		await mount()
		goRecovery()
		fireEvent.click(screen.getByRole('button', { name: 'scan_recovery_qr' }))
		await waitFor(() => expect((globalThis as { __panelOnCode?: unknown }).__panelOnCode).toBeTruthy())
		act(() => (globalThis as { __panelOnCode?: (c: string) => void }).__panelOnCode?.(CODE))
		expect(codeBox().value).toBe(CODE)
	})

	it('iOS shell: a paste is taken by the page and the clipboard is emptied', async () => {
		;(globalThis as { __host?: string }).__host = 'ios'
		const write = jest.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
		await mount()
		goRecovery()
		fireEvent.paste(codeBox(), { clipboardData: { getData: () => CODE } })
		expect(codeBox().value).toBe(CODE)
		expect(write).toHaveBeenCalledWith('')
	})
})

describe('shell: results and retry', () => {
	it.each([
		['not_found', 'recovery.native.not_found'],
		['network_error', 'network_error'],
		['already_exists', 'recovery.native.already_exists'],
		['record_invalid', 'recovery.native.record_invalid'],
		['write_failed', 'recovery.native.write_failed'],
		['readback_failed', 'recovery.native.write_failed'],
		['legacy_record', 'recovery.native.legacy_record'],
		['invalid_format', 'invalid_recovery_code_format'],
		['busy', 'recovery.native.busy'],
		['unknown', 'recovery.native.import_incomplete'],
		['invalid_key', 'something_went_wrong_while_restoring_your_wallet'],
	])('%s shows %s and the form returns for a retry', async (code, key) => {
		await mount()
		fillLogin()
		await submitLogin()
		await act(async () => emit({ code }))
		expect(screen.getAllByText(key).length).toBeGreaterThan(0)
		expect(screen.getByPlaceholderText('••••••••••••')).toBeTruthy()
	})

	it('backoff shows the seconds and refuses a new submit until the cooldown is over', async () => {
		await mount()
		fillLogin()
		await submitLogin()
		await act(async () => emit({ code: 'backoff', cooldownSec: 30 }))
		expect(screen.getAllByText('recovery.native.backoff|{"seconds":30}').length).toBeGreaterThan(0)
		fillLogin()
		await submitLogin()
		expect(submit).toHaveBeenCalledTimes(1)
	})

	it('a refused submit (shell answers origin_refused) shows the origin copy and the form stays usable', async () => {
		submit.mockResolvedValue({ ok: false, reason: 'origin_refused' })
		await mount()
		fillLogin()
		await submitLogin()
		expect(screen.getAllByText('recovery.native.untrusted_origin').length).toBeGreaterThan(0)
		expect(screen.getByPlaceholderText('••••••••••••')).toBeTruthy()
	})

	it('a session the engine no longer has (not_available) is reopened on the next try', async () => {
		submit.mockResolvedValueOnce({ ok: false, reason: 'not_available' })
		await mount()
		fillLogin()
		await submitLogin()
		fillLogin()
		await submitLogin()
		expect(open).toHaveBeenCalledTimes(2)
	})

	it('a failed open shows its reason and sends nothing', async () => {
		open.mockResolvedValue({ ok: false, reason: 'not_supported' })
		await mount()
		fillLogin()
		await submitLogin()
		expect(submit).not.toHaveBeenCalled()
		expect(screen.getAllByText('recovery.native.not_supported').length).toBeGreaterThan(0)
	})

	it('going back with a session open sends nativeRecoveryCancel once', async () => {
		const { onClose } = await mount()
		fillLogin()
		await submitLogin()
		await act(async () => emit({ code: 'bad_pin' }))
		fireEvent.click(screen.getByRole('button', { name: 'back' }))
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(onClose).toHaveBeenCalled()
	})

	it('going back before any submit sends no cancel (no session was opened)', async () => {
		await mount()
		fireEvent.click(screen.getByRole('button', { name: 'back' }))
		expect(cancel).not.toHaveBeenCalled()
	})
})

describe('shell: the gate (capability, origin, frame)', () => {
	it('capability missing: error and retry, no forms, no native page, nothing sent', async () => {
		hasCap.mockResolvedValue(false)
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		await waitFor(() => expect(screen.getByText('recovery.native.capability_missing')).toBeTruthy())
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(open).not.toHaveBeenCalled()
		hasCap.mockResolvedValue(true)
		fireEvent.click(screen.getByText('recovery.native.retry'))
		await waitFor(() => expect(screen.getByPlaceholderText('yourtag')).toBeTruthy())
	})

	it('untrusted origin: error and retry, no forms', async () => {
		trusted.mockReturnValue(false)
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		await waitFor(() => expect(screen.getByText('recovery.native.untrusted_origin')).toBeTruthy())
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
		expect(hasCap).not.toHaveBeenCalled()
	})

	it('a child frame is refused', async () => {
		topFrame.mockReturnValue(false)
		render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		await waitFor(() => expect(screen.getByText('recovery.native.untrusted_origin')).toBeTruthy())
		expect(screen.queryByPlaceholderText('yourtag')).toBeNull()
	})
})

describe('hidden page masks the secret fields again', () => {
	it('a hidden page turns the peek toggles off', async () => {
		await mount()
		fireEvent.click(screen.getByLabelText('show_password'))
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).type).toBe('text')
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).type).toBe('password')
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
	})
})

describe('shell: the result wait is bounded (120 s)', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('no result event in 120 s after an accepted submit: the session is cancelled, generic copy shows, the state stays cleared, and a new submit reopens the session', async () => {
		await mount()
		fillLogin()
		jest.useFakeTimers()
		await submitLogin()
		expect(submit).toHaveBeenCalledTimes(1)
		// still waiting just before the limit: no cancel, no form
		act(() => {
			jest.advanceTimersByTime(119_000)
		})
		expect(cancel).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText('••••••••••••')).toBeNull()
		act(() => {
			jest.advanceTimersByTime(1_000)
		})
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(screen.getAllByText('something_went_wrong_while_restoring_your_wallet').length).toBeGreaterThan(0)
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).value).toBe('')
		expect(document.body.textContent).not.toContain(PASSWORD)
		// retry: the old session is gone, so a new one is opened and the credential goes out again
		fillLogin()
		await submitLogin()
		expect(open).toHaveBeenCalledTimes(2)
		expect(submit).toHaveBeenCalledTimes(2)
	})

	it('the recovery code path times out the same way', async () => {
		await mount()
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: CODE } })
		jest.useFakeTimers()
		await submitCode()
		act(() => {
			jest.advanceTimersByTime(120_000)
		})
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(codeBox().value).toBe('')
		expect(screen.getAllByText('something_went_wrong_while_restoring_your_wallet').length).toBeGreaterThan(0)
	})

	it('a result event before the limit stops the timer: no cancel later', async () => {
		await mount()
		fillLogin()
		jest.useFakeTimers()
		await submitLogin()
		await act(async () => emit({ code: 'bad_pin' }))
		act(() => {
			jest.advanceTimersByTime(300_000)
		})
		expect(cancel).not.toHaveBeenCalled()
	})

	it('unmounting the page stops the timer: the unmount cancel is the only one', async () => {
		const view = render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={jest.fn()} />)
		await waitFor(() => expect(screen.getByPlaceholderText('yourtag')).toBeTruthy())
		fillLogin()
		jest.useFakeTimers()
		await submitLogin()
		view.unmount()
		expect(cancel).toHaveBeenCalledTimes(1)
		act(() => {
			jest.advanceTimersByTime(300_000)
		})
		expect(cancel).toHaveBeenCalledTimes(1)
	})
})
