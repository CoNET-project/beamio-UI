/**
 * 0.53.50 (plan r3-create): the onboarding create in a shell, real component, simulated shell replies (the shells and SDKs are not built yet).
 * Order nativeAccountCreateOpen -> accountCreateRegister -> addUser, the recover code in memory only with the screen protected, failures and
 * retries. SYNTHETIC values only.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as never
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/services/beamio', () => ({
	checkBeamioAccountAPI: jest.fn(async () => true),
	createRecover: jest.fn(),
	LocalCreateError: class extends Error {},
	CreateRemoteError: class extends Error {},
	getUserInfoLookup: jest.fn(),
	postAddUserPayload: jest.fn(),
	registryHasAccount: jest.fn(),
}))
jest.mock('@/services/walletEoaAddress', () => ({ readWalletEoaAddress: jest.fn() }))
jest.mock('@/services/nativeRecovery', () => ({
	nativeAccountCreateOpen: jest.fn(),
	onNativeAccountCreateResult: jest.fn(),
	queryNativeWalletStatusForPreCheck: jest.fn(),
}))
jest.mock('@/services/shellPageCreate', () => ({ hasPageCreate: jest.fn(), sendAccountCreateRegister: jest.fn(), setSecureScreen: jest.fn() }))
jest.mock('@/services/nativeIdentityProbeRetry', () => ({ requestNativeIdentityRetry: jest.fn() }))
jest.mock('@/services/nativeWallet', () => ({ notifyNativeWalletReady: jest.fn(), reachNativeWallet: jest.fn(), rememberNativeEoa: jest.fn() }))
jest.mock('@/services/nativeWalletEstablished', () => ({ announceNativeWalletEstablished: jest.fn() }))
jest.mock('@/services/nativeFlowPending', () => ({ announceNativeFlowPending: jest.fn() }))
jest.mock('@/services/shellChatCapability', () => ({ ensureShellChatState: jest.fn() }))
jest.mock('@/services/shellContext', () => ({ isShellContext: () => true }))
jest.mock('@/services/argon2WorkerBridge', () => ({ warmArgon2Worker: jest.fn() }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('./RecoveryQRScreen', () => ({ getActivatingSteps: () => [] }))
jest.mock('./VerraFloatingNavChrome', () => ({ VerraFloatingNavChrome: () => null }))
jest.mock('@/components/IpfsImg', () => ({ IpfsImg: () => null }))
jest.mock('@/components/InvitedByIntroducerChip', () => ({ InvitedByIntroducerChip: () => null }))
// the registration orchestration is real; only its deps are simulated (no real sleep)
jest.mock('@/services/accountCreateRegister', () => {
	const actual = jest.requireActual('@/services/accountCreateRegister')
	return {
		...actual,
		realRegisterDeps: async () => {
			const beamio = jest.requireMock('@/services/beamio')
			const create = jest.requireMock('@/services/shellPageCreate')
			const eoa = jest.requireMock('@/services/walletEoaAddress')
			return {
				send: async (cmd: { reqId: number; tag: string; password: string }) => create.sendAccountCreateRegister({ reqId: cmd.reqId, tag: cmd.tag, password: cmd.password }),
				forward: async (body: unknown) => beamio.postAddUserPayload(body),
				registryHas: beamio.registryHasAccount,
				existingEoa: async () => {
					const r = await eoa.readWalletEoaAddress()
					return r && r.kind === 'address' ? r.eoa : ''
				},
				sleep: async () => undefined,
			}
		},
	}
})

const CreateUsernamePinScreen = require('./CreateUsernamePinScreen').default
const beamio = require('@/services/beamio')
const nr = require('@/services/nativeRecovery')
const spc = require('@/services/shellPageCreate')
const chatCap = require('@/services/shellChatCapability')
const eoaMod = require('@/services/walletEoaAddress')
const retry = require('@/services/nativeIdentityProbeRetry')
const wallet = require('@/services/nativeWallet')
const { resetAccountCreateRegisterForTest } = require('@/services/accountCreateRegister')

const TAG = 'synthtag01'
const PWD = 'Abcdefg1x'
const WALLET = '0x' + '1'.repeat(40)
const CODE = 'Abc123XyzRecoverCode'
const RESULT = { accountName: TAG, wallet: WALLET, signMessage: '0x' + 'a'.repeat(130), recover: [{ hash: 'h1', encrypto: 'e1' }], recoverCodeBase58: CODE }
const OK_ENVELOPE = { type: 'ack', ok: true, reqId: 1, result: RESULT }

let emitCreate: (r: { code: string; eoa?: string; reason?: string }) => void

beforeEach(() => {
	jest.clearAllMocks()
	resetAccountCreateRegisterForTest()
	localStorage.clear()
	sessionStorage.clear()
	jest.useRealTimers()
	beamio.checkBeamioAccountAPI.mockImplementation(async () => true)
	chatCap.ensureShellChatState.mockImplementation(async () => 'native_chat')
	spc.hasPageCreate.mockResolvedValue(true)
	spc.setSecureScreen.mockResolvedValue(true)
	spc.sendAccountCreateRegister.mockResolvedValue(OK_ENVELOPE)
	beamio.postAddUserPayload.mockResolvedValue({ kind: 'ok' })
	beamio.registryHasAccount.mockResolvedValue('no')
	beamio.getUserInfoLookup.mockResolvedValue({ status: 'no_account' })
	eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: WALLET })
	wallet.reachNativeWallet.mockResolvedValue({ status: 'unlocked' })
	nr.nativeAccountCreateOpen.mockResolvedValue({ ok: true, page: 'none' })
	nr.onNativeAccountCreateResult.mockImplementation((cb: typeof emitCreate) => {
		emitCreate = cb
		return () => undefined
	})
})

const tagInput = () => document.getElementById('create-beamio-tag-input') as HTMLInputElement
const mount = async (opts: { typeTag?: boolean } = {}) => {
	const onRequestRestore = jest.fn()
	const view = render(<CreateUsernamePinScreen close={jest.fn()} onRequestRestore={onRequestRestore} />)
	const tag = tagInput()
	if (opts.typeTag !== false) fireEvent.change(tag, { target: { value: TAG } })
	fireEvent.change(document.getElementById('create-wallet-password') as HTMLInputElement, { target: { value: PWD } })
	fireEvent.click(screen.getByRole('checkbox'))
	fireEvent.blur(tag)
	await waitFor(() => expect(next().disabled).toBe(false), { timeout: 5000 })
	return { onRequestRestore, view }
}
const next = () => screen.getByText('next').closest('button') as HTMLButtonElement
const press = async () => {
	await act(async () => {
		fireEvent.click(next())
	})
}
const refill = async () => {
	fireEvent.change(document.getElementById('create-wallet-password') as HTMLInputElement, { target: { value: PWD } })
	await waitFor(() => expect(next().disabled).toBe(false), { timeout: 5000 })
}
const created = async () => {
	await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
	await act(async () => emitCreate({ code: 'ok', eoa: WALLET }))
}

describe('the three steps', () => {
	it('opens the native create, waits for its result, registers with {tag, password}, forwards addUser, then shows the recover code in memory only', async () => {
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(nr.nativeAccountCreateOpen).toHaveBeenCalledWith(TAG)
		// step 2 does not start before step 1 reports
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
		await act(async () => emitCreate({ code: 'ok', eoa: WALLET }))
		await waitFor(() => expect(spc.sendAccountCreateRegister).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(spc.sendAccountCreateRegister.mock.calls[0][0]).toMatchObject({ tag: TAG, password: PWD })
		expect(nr.nativeAccountCreateOpen.mock.invocationCallOrder[0]).toBeLessThan(spc.sendAccountCreateRegister.mock.invocationCallOrder[0])
		await waitFor(() => expect(beamio.postAddUserPayload).toHaveBeenCalledTimes(1))
		expect(beamio.postAddUserPayload.mock.calls[0][0]).toEqual({ accountName: TAG, recover: RESULT.recover, wallet: WALLET, signMessage: RESULT.signMessage })
		// the recover code shows after the forward, with the screen protected, and cannot be selected or copied
		const codeEl = await screen.findByTestId('recover-code')
		expect(codeEl.textContent).toBe(CODE)
		expect(spc.setSecureScreen).toHaveBeenCalledWith(true)
		expect((codeEl as HTMLElement).style.userSelect).toBe('none')
		expect(codeEl.className).not.toContain('select-all')
		const copy = new Event('copy', { bubbles: true, cancelable: true })
		codeEl.dispatchEvent(copy)
		expect(copy.defaultPrevented).toBe(true)
		// not stored anywhere
		for (const store of [localStorage, sessionStorage]) {
			for (let i = 0; i < store.length; i++) expect(`${store.key(i)}=${store.getItem(store.key(i) as string)}`).not.toContain(CODE)
		}
		// the wallet is not entered before the user confirms
		expect(wallet.notifyNativeWalletReady).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId('recover-code-saved'))
		await act(async () => {
			fireEvent.click(screen.getByTestId('recover-code-continue'))
		})
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(spc.setSecureScreen).toHaveBeenLastCalledWith(false)
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET))
		expect(beamio.createRecover).not.toHaveBeenCalled()
	})

	it('the password and the recover code never reach console, logs or the page store', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined))
		const { publishNativePwaLog } = jest.requireMock('@/utils/cashTreesNativePwaLog') as { publishNativePwaLog: jest.Mock }
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		const seen = JSON.stringify([...spies.flatMap((s) => s.mock.calls), ...publishNativePwaLog.mock.calls])
		expect(seen).not.toContain(PWD)
		expect(seen).not.toContain(CODE)
		spies.forEach((s) => s.mockRestore())
	})

	it('the password field is empty once the call returned', async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		fireEvent.click(screen.getByTestId('recover-code-saved'))
		await act(async () => {
			fireEvent.click(screen.getByTestId('recover-code-continue'))
		})
		expect((document.getElementById('create-wallet-password') as HTMLInputElement | null)?.value ?? '').toBe('')
	})

	it('leaving the page with the code on screen turns the screen protection off and drops the code', async () => {
		const { view } = await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		spc.setSecureScreen.mockClear()
		view.unmount()
		expect(spc.setSecureScreen).toHaveBeenCalledTimes(1)
		expect(spc.setSecureScreen).toHaveBeenCalledWith(false)
		expect(document.body.textContent).not.toContain(CODE)
	})
})

describe('refusals before and during step 1', () => {
	it('without account.page-create.v1 nothing is sent and the unavailable copy shows (no native page, no page-side key)', async () => {
		spc.hasPageCreate.mockResolvedValue(false)
		await mount()
		await press()
		expect(await screen.findByText('create_account_native_unavailable')).toBeTruthy()
		expect(nr.nativeAccountCreateOpen).not.toHaveBeenCalled()
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
		expect(beamio.createRecover).not.toHaveBeenCalled()
	})

	it('a failed open sends no registration', async () => {
		nr.nativeAccountCreateOpen.mockResolvedValue({ ok: false, reason: 'not_ready' })
		await mount()
		await press()
		expect(await screen.findByText('create_account_try_later')).toBeTruthy()
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
	})

	it.each(['write_failed', 'lookup_unavailable', 'not_ready'])('a %s result ends the run before step 2 and the form returns', async (code) => {
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		await act(async () => emitCreate({ code, reason: 'internal_state' }))
		await waitFor(() => expect(screen.queryByText('next')).toBeTruthy(), { timeout: 5000 })
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
	})

	it('already_bound opens the PWA restore page', async () => {
		const { onRequestRestore } = await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_bound' }))
		await waitFor(() => expect(onRequestRestore).toHaveBeenCalledWith(TAG))
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
	})
})

describe('an account the device already has (already_exists)', () => {
	it('the registry holds no tag for it: the registration is completed (step 2 and 3)', async () => {
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_exists' }))
		await waitFor(() => expect(spc.sendAccountCreateRegister).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(beamio.getUserInfoLookup).toHaveBeenCalledWith(WALLET)
		await screen.findByTestId('recover-code')
	})

	it('the registry already holds an account for it: back to the entry judgement, nothing is registered', async () => {
		beamio.getUserInfoLookup.mockResolvedValue({ status: 'ok', info: {} })
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_exists' }))
		await waitFor(() => expect(retry.requestNativeIdentityRetry).toHaveBeenCalledTimes(1))
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
	})

	it('the account cannot be read: back to the entry judgement', async () => {
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'locked' })
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_exists' }))
		await waitFor(() => expect(retry.requestNativeIdentityRetry).toHaveBeenCalledTimes(1))
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
	})
})

describe('step 2 and 3 failures', () => {
	it('tag_taken from the register answer returns to renaming; no addUser, no recover code', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'tag_taken' })
		await mount()
		await press()
		await created()
		expect(await screen.findByText('tag_is_already_taken')).toBeTruthy()
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		expect(screen.queryByTestId('recover-code')).toBeNull()
	})

	it('the shell answers nothing (unavailable): the unavailable copy shows, nothing is forwarded', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue(null)
		await mount()
		await press()
		await created()
		expect(await screen.findByText('create_account_native_unavailable')).toBeTruthy()
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
	})

	it('addUser fails after the retries: the recover code is NOT shown; the retry reuses the same payload and does not register again', async () => {
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 503 })
		await mount()
		await press()
		await created()
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		// the 2, 4 and 8 s retries ran (four posts), and no code was shown to the user
		expect(beamio.postAddUserPayload).toHaveBeenCalledTimes(4)
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(spc.sendAccountCreateRegister).toHaveBeenCalledTimes(1)
		// manual retry: step 1 answers already_exists (the key exists), the held payload is forwarded, no second registration command
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'ok' })
		await refill()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledTimes(2), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_exists' }))
		await screen.findByTestId('recover-code')
		expect(spc.sendAccountCreateRegister).toHaveBeenCalledTimes(1)
		expect(beamio.postAddUserPayload).toHaveBeenCalledTimes(5)
	})

	it('already_registered (the registry has it, no recover code): no addUser, enters after the answer', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'already_registered' })
		await mount()
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		expect(screen.queryByTestId('recover-code')).toBeNull()
	})
})

describe('r3sk 1: the screen protection is on before the recover code is rendered', () => {
	it('secureScreen(on) is asked first; the code is rendered only after it answered ok', async () => {
		let release: (v: boolean) => void = () => undefined
		spc.setSecureScreen.mockImplementation((on: boolean) => (on ? new Promise<boolean>((r) => { release = r }) : Promise.resolve(true)))
		await mount()
		await press()
		await created()
		await waitFor(() => expect(spc.setSecureScreen).toHaveBeenCalledWith(true), { timeout: 5000 })
		// the shell has not answered yet: no code on screen
		expect(screen.queryByTestId('recover-code')).toBeNull()
		await act(async () => release(true))
		expect((await screen.findByTestId('recover-code')).textContent).toBe(CODE)
	})

	it('a shell that cannot protect the screen (error answer): no code is shown, "unavailable" shows, the wallet is not entered', async () => {
		spc.setSecureScreen.mockResolvedValue(false)
		await mount()
		await press()
		await created()
		expect(await screen.findByText('create_account_native_unavailable')).toBeTruthy()
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(document.body.textContent).not.toContain(CODE)
		expect(wallet.notifyNativeWalletReady).not.toHaveBeenCalled()
	})
})

describe('r3sk 2: the recover code is hidden after 5 minutes of wall-clock time', () => {
	const showCode = async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
	}
	const visible = () => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

	it('coming back to the foreground after a throttled background: the code is cleared at once, without any timer having fired', async () => {
		await showCode()
		jest.useFakeTimers()
		// the page was in the background: timers did not run, the clock moved on
		jest.setSystemTime(Date.now() + 299_000)
		visible()
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		expect(screen.queryByTestId('recover-code')).toBeTruthy() // 4:59: still shown
		jest.setSystemTime(Date.now() + 2_000)
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(document.body.textContent).not.toContain(CODE)
		expect(spc.setSecureScreen).toHaveBeenLastCalledWith(false)
		expect(screen.getAllByText('create_account_recover_code_expired').length).toBeGreaterThan(0)
		expect(wallet.notifyNativeWalletReady).not.toHaveBeenCalled()
	})

	it.each([['resume', () => document.dispatchEvent(new Event('resume'))], ['pageshow', () => window.dispatchEvent(new Event('pageshow'))], ['focus', () => window.dispatchEvent(new Event('focus'))]])('the %s event checks the absolute time too', async (_n, fire) => {
		await showCode()
		jest.useFakeTimers()
		jest.setSystemTime(Date.now() + 301_000)
		act(() => {
			fire()
		})
		expect(screen.queryByTestId('recover-code')).toBeNull()
	})

	it('a hidden page does not clear early: visibilitychange while hidden never expires the code before 5 minutes', async () => {
		await showCode()
		jest.useFakeTimers()
		jest.setSystemTime(Date.now() + 10_000)
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		expect(screen.queryByTestId('recover-code')).toBeTruthy()
		visible()
	})

	it('the user confirming before the limit enters as before, and nothing expires later', async () => {
		await showCode()
		fireEvent.click(screen.getByTestId('recover-code-saved'))
		await act(async () => {
			fireEvent.click(screen.getByTestId('recover-code-continue'))
		})
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET))
		jest.useFakeTimers()
		jest.setSystemTime(Date.now() + 600_000)
		act(() => {
			window.dispatchEvent(new Event('focus'))
		})
		expect(screen.queryByText('create_account_recover_code_expired')).toBeNull()
	})
})

describe('r3sk/r3sl 3: the tag of step 1 is the tag of step 2, recorded per wallet', () => {
	const KEY = 'beamio.pendingCreateTag.v2'
	const record = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>

	it('step 1 passed: the tag is recorded under the wallet and locked in the field; a failed step 2 retries with the same tag', async () => {
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 503 })
		await mount()
		await press()
		await created()
		expect(await screen.findByText('network_error_try_again')).toBeTruthy()
		expect(record()).toEqual({ [WALLET]: TAG })
		expect(tagInput().readOnly).toBe(true)
		expect(tagInput().value).toBe(TAG)
		fireEvent.change(tagInput(), { target: { value: 'othertag99' } })
		expect(tagInput().value).toBe(TAG)
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'ok' })
		await refill()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledTimes(2), { timeout: 5000 })
		expect(nr.nativeAccountCreateOpen).toHaveBeenLastCalledWith(TAG)
		await act(async () => emitCreate({ code: 'already_exists' }))
		await screen.findByTestId('recover-code')
		// only the tag and the wallet are stored: no password, no recover code
		for (const store of [localStorage, sessionStorage]) {
			for (let i = 0; i < store.length; i++) {
				const entry = `${store.key(i)}=${store.getItem(store.key(i) as string)}`
				expect(entry).not.toContain(CODE)
				expect(entry).not.toContain(PWD)
			}
		}
	})

	it('a killed app and a new start: the record of this wallet locks the same tag, prefilled; the tag check is not asked; step 1 and 2 use it', async () => {
		// the first run: step 1 passed, then the app was killed (the page is gone, the record stays)
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		cleanup()
		expect(record()).toEqual({ [WALLET]: TAG })
		// the new start: the device has the wallet; the page finds the record for it
		jest.clearAllMocks()
		beamio.checkBeamioAccountAPI.mockImplementation(async () => true)
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: WALLET })
		nr.nativeAccountCreateOpen.mockResolvedValue({ ok: true, page: 'none' })
		nr.onNativeAccountCreateResult.mockImplementation((cb: typeof emitCreate) => {
			emitCreate = cb
			return () => undefined
		})
		await mount({ typeTag: false })
		await waitFor(() => expect(tagInput().value).toBe(TAG))
		expect(tagInput().readOnly).toBe(true)
		fireEvent.change(tagInput(), { target: { value: 'sneaky' } })
		expect(tagInput().value).toBe(TAG)
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledWith(TAG), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'already_exists' }))
		await waitFor(() => expect(spc.sendAccountCreateRegister).toHaveBeenCalledTimes(1), { timeout: 5000 })
		expect(spc.sendAccountCreateRegister.mock.calls[0][0]).toMatchObject({ tag: TAG })
		expect(beamio.checkBeamioAccountAPI).not.toHaveBeenCalled()
	})

	it('a record of another wallet does not lock this one; no record at all (another browser, cleared storage): the user types the tag', async () => {
		localStorage.setItem(KEY, JSON.stringify({ ['0x' + '2'.repeat(40)]: 'otherwallettag' }))
		await mount()
		await waitFor(() => expect(eoaMod.readWalletEoaAddress).toHaveBeenCalled())
		expect(tagInput().readOnly).toBe(false)
		expect(tagInput().value).toBe(TAG)
		cleanup()
		localStorage.clear()
		await mount()
		expect(tagInput().readOnly).toBe(false)
	})

	it('a wallet that cannot be read locks nothing', async () => {
		localStorage.setItem(KEY, JSON.stringify({ [WALLET]: 'lockedtag77' }))
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'locked' })
		await mount()
		expect(tagInput().readOnly).toBe(false)
		expect(tagInput().value).toBe(TAG)
	})

	it('clearing time: the record stays while the recover code is on screen and after it hides unconfirmed; it goes when the user confirmed the code is saved', async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		expect(record()).toEqual({ [WALLET]: TAG })
		fireEvent.click(screen.getByTestId('recover-code-saved'))
		// ticking the box is not the confirmation: the record is still there
		expect(record()).toEqual({ [WALLET]: TAG })
		await act(async () => {
			fireEvent.click(screen.getByTestId('recover-code-continue'))
		})
		await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
	})

	it('clearing time: the record stays when the code hides after 5 minutes unconfirmed (the completion must still find the tag)', async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		jest.useFakeTimers()
		jest.setSystemTime(Date.now() + 301_000)
		act(() => {
			window.dispatchEvent(new Event('focus'))
		})
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(record()).toEqual({ [WALLET]: TAG })
	})

	it('clearing time: a registration that was complete already (already_registered, no code) clears the record when the page enters', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'already_registered' })
		await mount()
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(localStorage.getItem(KEY)).toBeNull()
	})

	it('a step 1 that fails leaves no record and no lock', async () => {
		nr.nativeAccountCreateOpen.mockResolvedValue({ ok: false, reason: 'not_ready' })
		await mount()
		await press()
		await screen.findByText('create_account_try_later')
		expect(localStorage.getItem(KEY)).toBeNull()
		expect(tagInput().readOnly).toBe(false)
	})

	it('tag_taken at step 2 releases the lock and the record so the user can choose another tag', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'tag_taken' })
		await mount()
		await press()
		await created()
		expect(await screen.findByText('tag_is_already_taken')).toBeTruthy()
		expect(localStorage.getItem(KEY)).toBeNull()
		await waitFor(() => expect(tagInput().readOnly).toBe(false))
	})
})
