/**
 * The restore page in a shell, real component, simulated shell replies. Rewritten for the current design: the PWA onboards itself in a shell too (restoreWithUserPin /
 * restoreWithRedeemDetailed in the page), and the shell receives the phrase only at the first /home through pwaWalletSync. The earlier tests (0.53.49 plan A: nativeRecoveryOpen,
 * nativeRecoverySubmit, result codes, cooldown, the 120 s wait, the capability gate) described a flow the page no longer has and are gone (30 cases, see PLAN-34-failing-tests-disposition).
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

})

describe('shell: recovery code', () => {
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

	describe('iOS shell paste', () => {
		const clip = () => {
			const write = jest.fn().mockResolvedValue(undefined)
			Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
			return write
		}
		const paste = (value: string) => {
			const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
			ev.clipboardData = { getData: () => value }
			act(() => {
				codeBox().dispatchEvent(ev)
			})
			return ev
		}

		beforeEach(() => {
			;(globalThis as { __host?: string }).__host = 'ios'
		})

		it('a recovery-code-format paste is taken by the page and the clipboard is emptied', async () => {
			const write = clip()
			await mount()
			goRecovery()
			const ev = paste(`  ${CODE}  `)
			expect(ev.defaultPrevented).toBe(true)
			expect(codeBox().value).toBe(CODE)
			expect(write).toHaveBeenCalledTimes(1)
			expect(write).toHaveBeenCalledWith('')
		})

		it.each([
			['a mnemonic', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
			['a private key', '0x' + '1'.repeat(64)],
			['a URL', 'https://example.invalid/restore'],
			['a 21-character code', CODE.slice(1)],
			['a 23-character code', CODE + 'x'],
			['text around a code', `my code ${CODE}`],
			['empty text', ''],
		])('%s: the default paste runs and the clipboard is not touched', async (_name, text) => {
			const write = clip()
			await mount()
			goRecovery()
			const ev = paste(text)
			expect(ev.defaultPrevented).toBe(false)
			expect(write).not.toHaveBeenCalled()
		})

		it('Android shell: the paste handler is not installed (default paste, clipboard untouched)', async () => {
			;(globalThis as { __host?: string }).__host = 'android'
			const write = clip()
			await mount()
			goRecovery()
			const ev = paste(CODE)
			expect(ev.defaultPrevented).toBe(false)
			expect(write).not.toHaveBeenCalled()
		})
	})
})

describe('shell: leaving the page', () => {
	it('going back before any submit sends no cancel (no session was opened)', async () => {
		await mount()
		fireEvent.click(screen.getByRole('button', { name: 'back' }))
		expect(cancel).not.toHaveBeenCalled()
	})
})

describe('shell: the gate (capability, origin, frame)', () => {
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

describe('shell: the page restores in the page, and never uses the native recovery functions', () => {
	const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
	const restored = () => ({ mnemonicPhrase: PHRASE, beamio: { accountName: 'synthtag' }, profiles: [{ keyID: '0x0', privateKeyArmor: 'armor' }] })
	const nativeUntouched = () => {
		for (const fn of [open, submit, cancel, hasCap, onResult]) expect(fn).not.toHaveBeenCalled()
	}
	beforeEach(() => {
		hasCap.mockClear()
		onResult.mockClear()
		;(restoreWithUserPin as jest.Mock).mockReset()
		;(restoreWithRedeemDetailed as jest.Mock).mockReset()
	})

	it('BeamioTag and password: the shell goes through restoreWithUserPin in the page, hands the result to onRestore, and calls no nativeRecovery* function', async () => {
		;(restoreWithUserPin as jest.Mock).mockResolvedValue(restored())
		const onRestore = jest.fn()
		await mount({ onRestore })
		fillLogin()
		await submitLogin()
		await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
		expect(restoreWithUserPin).toHaveBeenCalledTimes(1)
		expect(restoreWithUserPin).toHaveBeenCalledWith('synthtag', PASSWORD)
		expect(restoreWithRedeemDetailed).not.toHaveBeenCalled()
		expect((onRestore.mock.calls[0][0] as { temp: { mnemonicPhrase: string } }).temp.mnemonicPhrase).toBe(PHRASE)
		nativeUntouched()
	})

	it('recovery code: the shell goes through restoreWithRedeemDetailed in the page, and calls no nativeRecovery* function', async () => {
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'ok', temp: restored() })
		const onRestore = jest.fn()
		await mount({ onRestore })
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: CODE } })
		await submitCode()
		await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
		expect(restoreWithRedeemDetailed).toHaveBeenCalledWith(CODE, '')
		expect(restoreWithUserPin).not.toHaveBeenCalled()
		nativeUntouched()
	})

	it('a wrong code shows the page copy and the line stays long after 4 seconds; typing in the box clears it (the page path, no native result code)', async () => {
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'invalid_code' })
		await mount()
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: CODE } })
		jest.useFakeTimers()
		try {
			await submitCode()
			expect(screen.getAllByText('invalid_recovery_code').length).toBeGreaterThan(0)
			act(() => {
				jest.advanceTimersByTime(60_000)
			})
			expect(screen.getAllByText('invalid_recovery_code').length).toBeGreaterThan(0)
		} finally {
			jest.useRealTimers()
		}
		fireEvent.change(codeBox(), { target: { value: 'a' } })
		expect(screen.queryByText('invalid_recovery_code')).toBeNull()
		nativeUntouched()
	})

	it('page path, wrong BeamioTag or password: the restore answers false (or rejects), the page shows the failure copy, the form stays usable, nothing is restored and no native function is called', async () => {
		for (const failure of [() => Promise.resolve(false), () => Promise.reject(new Error('wrong'))]) {
			;(restoreWithUserPin as jest.Mock).mockReset()
			;(restoreWithUserPin as jest.Mock).mockImplementation(failure)
			const onRestore = jest.fn()
			const { unmount } = (() => {
				const r = render(<RestoreWalletUnifiedScreen onClose={jest.fn()} onRestore={onRestore} />)
				return r
			})()
			await waitFor(() => expect(screen.getByPlaceholderText('yourtag')).toBeTruthy())
			fillLogin()
			await submitLogin()
			await waitFor(() => expect(screen.getAllByText('something_went_wrong_while_restoring_your_wallet').length).toBeGreaterThan(0))
			expect(onRestore).not.toHaveBeenCalled()
			expect(screen.getByPlaceholderText('yourtag')).toBeTruthy() // the form is back and usable
			expect(restoreWithRedeemDetailed).not.toHaveBeenCalled()
			nativeUntouched()
			unmount()
		}
	})

	it('KNOWN GAP: on the page path the secret inputs are NOT cleared by the submit. The password and the recovery code stay in the component state and in the field (the old native path cleared them at once); after a successful submit the screen only goes away when the parent unmounts it', async () => {
		;(restoreWithUserPin as jest.Mock).mockResolvedValue(restored())
		;(restoreWithRedeemDetailed as jest.Mock).mockResolvedValue({ kind: 'ok', temp: restored() })
		await mount({ onRestore: jest.fn() })
		fillLogin()
		await submitLogin()
		await waitFor(() => expect(restoreWithUserPin).toHaveBeenCalled())
		expect((screen.getByPlaceholderText('••••••••••••') as HTMLInputElement).value).toBe(PASSWORD) // the gap: still there
		goRecovery()
		fireEvent.change(codeBox(), { target: { value: CODE } })
		await submitCode()
		await waitFor(() => expect(restoreWithRedeemDetailed).toHaveBeenCalled())
		expect(codeBox().value).toBe(CODE) // the gap: still there
	})

	it('the screen source has no nativeRecovery* call, no onNativeRecoveryResult and no nativeRecoverySubmit (the shell phrase handoff is pwaWalletSync at the first /home)', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'RestoreWalletUnifiedScreen.tsx'), 'utf8') as string
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
		expect(code).not.toMatch(/nativeRecovery(Open|Submit|Cancel|CopyKey)|onNativeRecoveryResult|hasPageInputRecovery|rememberNativeEoa|notifyNativeWalletReady/)
		expect(code).toMatch(/restoreWithUserPin\(trimmed, password\)/)
		expect(code).toMatch(/restoreWithRedeemDetailed\(recoveryCode, ''\)/)
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
