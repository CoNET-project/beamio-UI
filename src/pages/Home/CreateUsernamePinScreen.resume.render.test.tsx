/**
 * 0.53.51 resume-create page cases (copy of the shell create harness). Original header: 0.53.50 (plan r3-create): the onboarding create in a shell, real component, simulated shell replies (the shells and SDKs are not built yet).
 * Order nativeAccountCreateOpen -> accountCreateRegister -> addUser, the recover code in memory only with the screen protected, failures and
 * retries. SYNTHETIC values only.
 */
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder })
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false })) as never
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getResumeNotice, dismissResumeNotice } from '@/services/resumeNotice'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key, useTu: () => ({ tu: (key: string) => key, locale: 'en' }) }))
jest.mock('@/services/beamio', () => ({
	checkBeamioAccountAPI: jest.fn(async () => true),
	createRecover: jest.fn(),
	LocalCreateError: class extends Error {},
	CreateRemoteError: class extends Error {},
	getUserInfoLookup: jest.fn(),
	registrationStateVia: jest.fn(),
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
	resumeMounted = false
	jest.clearAllMocks()
	dismissResumeNotice()
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
	beamio.registrationStateVia.mockResolvedValue('unregistered')
	eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: WALLET })
	wallet.reachNativeWallet.mockResolvedValue({ status: 'unlocked' })
	nr.nativeAccountCreateOpen.mockResolvedValue({ ok: true, page: 'none' })
	nr.onNativeAccountCreateResult.mockImplementation((cb: typeof emitCreate) => {
		emitCreate = cb
		return () => undefined
	})
})

const tagInput = () => document.getElementById('create-beamio-tag-input') as HTMLInputElement
let resumeMounted = false
const mount = async (opts: { typeTag?: boolean; resume?: { eoa: string; tag: string } } = {}) => {
	resumeMounted = !!opts.resume
	const onRequestRestore = jest.fn()
	const view = render(<CreateUsernamePinScreen close={jest.fn()} onRequestRestore={onRequestRestore} resumeEoa={opts.resume?.eoa} resumeTag={opts.resume?.tag} />)
	const tag = tagInput()
	if (opts.typeTag !== false && !opts.resume) fireEvent.change(tag, { target: { value: TAG } })
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
	// a resume page sends no step 1 (the device already holds the key): there is no create result to wait for, step 2 follows the press directly
	if (resumeMounted) {
		await waitFor(() => expect(spc.sendAccountCreateRegister).toHaveBeenCalled(), { timeout: 5000 })
		return
	}
	await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
	await act(async () => emitCreate({ code: 'ok', eoa: WALLET }))
}


const KEY = 'beamio.pendingCreateTag.v2'
const rec = () => (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, { t: string; s?: number; a?: number } | string>)[WALLET]
const seedRecord = () => localStorage.setItem(KEY, JSON.stringify({ [WALLET]: { t: TAG } }))
const RESUME = { eoa: WALLET, tag: TAG }
const noticeShown = () => getResumeNotice()?.kind ?? null

describe('resume: the tag is locked, there is nothing to choose', () => {
	it('the tag field is read-only with the recorded tag; no tag lookup runs on mount', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		expect(tagInput().readOnly).toBe(true)
		expect(tagInput().value).toBe(TAG)
		expect(beamio.checkBeamioAccountAPI).not.toHaveBeenCalled()
		expect(nr.queryNativeWalletStatusForPreCheck).not.toHaveBeenCalled()
	})

	it('pressing next sends NO step 1: the locked tag goes straight to step 2 and 3, and the recover code shows (no N1 notice)', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		await press()
		await waitFor(() => expect(spc.sendAccountCreateRegister.mock.calls[0]?.[0]).toMatchObject({ tag: TAG, password: PWD }), { timeout: 5000 })
		expect(nr.nativeAccountCreateOpen).not.toHaveBeenCalled()
		// the native flow is announced as pending while steps 2 and 3 run (the gate does not take the screen over meanwhile)
		const { announceNativeFlowPending } = jest.requireMock('@/services/nativeFlowPending') as { announceNativeFlowPending: jest.Mock }
		expect(announceNativeFlowPending).toHaveBeenCalledWith(true)
		expect(await screen.findByTestId('recover-code')).toBeTruthy()
		expect(noticeShown()).toBeNull()
	})

	it.each([
		['not_available (Android: a key exists)', { ok: false, reason: 'not_available' }],
		['already_exists', { ok: true, page: 'none' }],
	])('whatever the shell would answer to step 1 (%s) cannot matter: it is not sent', async (_n, answer) => {
		seedRecord()
		nr.nativeAccountCreateOpen.mockResolvedValue(answer)
		await mount({ resume: RESUME })
		await press()
		expect(await screen.findByTestId('recover-code')).toBeTruthy()
		expect(nr.nativeAccountCreateOpen).not.toHaveBeenCalled()
		expect(screen.queryByText('create_account_native_unavailable')).toBeNull()
	})

	it('the normal page still sends step 1 first (unchanged)', async () => {
		await mount()
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledWith(TAG), { timeout: 5000 })
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled() // step 2 waits for the step 1 result
	})

	it('there is no way to put the lock aside on the page (no later / skip control)', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		expect(screen.queryByText(/later|skip/i)).toBeNull()
	})
})

describe('D2 in a resume: the device wallet must be the one the gate found', () => {
	const OTHER = '0x' + '2'.repeat(40)
	it('soft check: the read-only wallet address answers another wallet: nothing is sent, the lock is dropped, the entry judges again', async () => {
		seedRecord()
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: OTHER })
		await mount({ resume: RESUME })
		await press()
		await waitFor(() => expect(retry.requestNativeIdentityRetry).toHaveBeenCalled(), { timeout: 5000 })
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		expect(nr.nativeAccountCreateOpen).not.toHaveBeenCalled()
		const all = JSON.parse(localStorage.getItem(KEY) ?? '{}')
		expect(all[OTHER]).toBeUndefined()
		expect(all[WALLET]).toBeTruthy() // the resume wallet's own record is left alone
		expect(tagInput().readOnly).toBe(false)
	})

	it('soft check answers the same wallet (any case): the resume goes on', async () => {
		seedRecord()
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'address', eoa: WALLET.toUpperCase().replace('0X', '0x') })
		await mount({ resume: RESUME })
		await press()
		expect(await screen.findByTestId('recover-code')).toBeTruthy()
	})

	it('no answer from the read-only address (refused) is not a mismatch: the resume goes on', async () => {
		seedRecord()
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'not_ready' })
		await mount({ resume: RESUME })
		await press()
		expect(await screen.findByTestId('recover-code')).toBeTruthy()
	})

	it('hard guard: the read-only address cannot tell, but step 2 answers for another wallet: no addUser, no s on the record, the lock is dropped', async () => {
		seedRecord()
		eoaMod.readWalletEoaAddress.mockResolvedValue({ kind: 'refused', code: 'not_ready' })
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: true, reqId: 1, result: { ...RESULT, wallet: OTHER } })
		await mount({ resume: RESUME })
		await press()
		await waitFor(() => expect(retry.requestNativeIdentityRetry).toHaveBeenCalled(), { timeout: 5000 })
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect((rec() as { s?: number } | undefined)?.s).toBeUndefined()
		expect(tagInput().readOnly).toBe(false)
	})
})

describe('the record: s before the first forward, a after a 2xx', () => {
	it('a normal create ends with s and a (positive integers) on the record, s not later than a', async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		const r = rec() as { t: string; s?: number; a?: number }
		expect(r.t).toBe(TAG)
		expect(Number.isInteger(r.s) && (r.s as number) > 0).toBe(true)
		expect(Number.isInteger(r.a) && (r.a as number) > 0).toBe(true)
		expect(r.s as number).toBeLessThanOrEqual(r.a as number)
	})

	it('s is on the record BEFORE the addUser request leaves, and a is not there yet', async () => {
		let atSend: { s?: number; a?: number } | null = null
		beamio.postAddUserPayload.mockImplementation(async () => {
			atSend = rec() as { s?: number; a?: number }
			return { kind: 'ok' }
		})
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		expect(atSend).not.toBeNull()
		expect((atSend as unknown as { s?: number }).s).toBeGreaterThan(0)
		expect((atSend as unknown as { a?: number }).a).toBeUndefined()
	})

	it('a refused forward (no 2xx) leaves s and never writes a', async () => {
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 400 })
		await mount()
		await press()
		await created()
		await waitFor(() => expect((rec() as { s?: number }).s).toBeGreaterThan(0), { timeout: 5000 })
		expect((rec() as { a?: number }).a).toBeUndefined()
	})
})

describe('N1 and F1: a resume page that ends on "already registered"', () => {
	it('409 and the registry holds the account (resume): no recover code on screen, the neutral N1 notice once, wallet entered', async () => {
		seedRecord()
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 409 })
		beamio.registryHasAccount.mockResolvedValue('yes')
		await mount({ resume: RESUME })
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(noticeShown()).toBe('already_registered_keep_password')
	})

	it('the same 409 on the NORMAL page: no recover code and the N1 notice too (the password just typed was not adopted)', async () => {
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 409 })
		beamio.registryHasAccount.mockResolvedValue('yes')
		await mount()
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect(noticeShown()).toBe('already_registered_keep_password')
	})

	it('a NORMAL page that ends on step 2 already_registered keeps the 0.53.50 behaviour: no notice (no password was typed over an earlier one: the step-2 answer is the shell\'s own)', async () => {
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'already_registered' })
		await mount()
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		expect(noticeShown()).toBeNull()
	})

	it('a RESUME page that ends on step 2 already_registered shows N1', async () => {
		seedRecord()
		spc.sendAccountCreateRegister.mockResolvedValue({ type: 'ack', ok: false, reqId: 1, error: 'already_registered' })
		await mount({ resume: RESUME })
		await press()
		await created()
		await waitFor(() => expect(wallet.notifyNativeWalletReady).toHaveBeenCalledWith(TAG, WALLET), { timeout: 5000 })
		expect(noticeShown()).toBe('already_registered_keep_password')
	})

	it('N1 is still shown for a wallet that earlier had the D3 notice', async () => {
		const { pushResumeNotice, dismissResumeNotice: dis } = require('@/services/resumeNotice')
		pushResumeNotice('code_not_shown', WALLET)
		dis()
		seedRecord()
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 409 })
		beamio.registryHasAccount.mockResolvedValue('yes')
		await mount({ resume: RESUME })
		await press()
		await created()
		await waitFor(() => expect(noticeShown()).toBe('already_registered_keep_password'), { timeout: 5000 })
	})

	it('CP-25 style: the notice keys hold only wallet -> true; the tag, the password and the code are in no other storage entry', async () => {
		seedRecord()
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 409 })
		beamio.registryHasAccount.mockResolvedValue('yes')
		await mount({ resume: RESUME })
		await press()
		await created()
		await waitFor(() => expect(noticeShown()).toBe('already_registered_keep_password'), { timeout: 5000 })
		// the card is not on this page: the flag is written when the notice is dismissed (or rendered by the card on the home)
		dismissResumeNotice()
		expect(JSON.parse(localStorage.getItem('beamio.passwordNoticeShown.v1') as string)).toEqual({ [WALLET]: true })
		for (const store of [localStorage, sessionStorage]) {
			for (let i = 0; i < store.length; i++) {
				const key = store.key(i) as string
				const entry = `${key}=${store.getItem(key)}`
				expect(entry).not.toContain(PWD)
				expect(entry).not.toContain(CODE)
				if (entry.includes(TAG)) expect(key).toBe(KEY)
			}
		}
	})
})

describe('0.53.51 resume-note on the recovery code page, and the ok:false forward', () => {
	it('a resume page that ends on a new code shows the merged note (discard the old code, use this one, use it if the password fails)', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		await press()
		await created()
		await screen.findByTestId('recover-code')
		expect(screen.getByTestId('recover-code-resumed-note').textContent).toBe('create_account_recover_code_resumed_note')
	})

	it('a resend after an earlier 2xx (the record had a) also shows it, and never says the new password is in force', async () => {
		localStorage.setItem(KEY, JSON.stringify({ [WALLET]: { t: TAG, s: Date.now() - 60 * 60_000, a: Date.now() - 59 * 60_000 } }))
		await mount({ resume: RESUME })
		await press()
		await created()
		await screen.findByTestId('recover-code')
		expect(screen.getByTestId('recover-code-resumed-note')).toBeTruthy()
		for (const f of ['en', 'zh-CN']) {
			const j = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../locale', f + '.json'), 'utf8')) as Record<string, string>
			const note = j.create_account_recover_code_resumed_note
			expect(note).toBeTruthy()
			expect(note).not.toMatch(/新密码一定|new password (will|is) (take|in force|effective)/i)
		}
	})

	it('the normal (not resumed) page shows no such note', async () => {
		await mount()
		await press()
		await created()
		await screen.findByTestId('recover-code')
		expect(screen.queryByTestId('recover-code-resumed-note')).toBeNull()
	})

	it('HTTP 200 + {ok:false} (the forward reports a server failure): no recover code, a is not written, the record stays', async () => {
		beamio.postAddUserPayload.mockResolvedValue({ kind: 'http', status: 500 })
		await mount()
		await press()
		await created()
		await waitFor(() => expect((rec() as { s?: number } | undefined)?.s).toBeGreaterThan(0), { timeout: 5000 })
		await waitFor(() => expect(beamio.postAddUserPayload.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 5000 })
		expect(screen.queryByTestId('recover-code')).toBeNull()
		expect((rec() as { a?: number } | undefined)?.a).toBeUndefined()
		expect(rec()).toBeTruthy()
		expect(wallet.notifyNativeWalletReady).not.toHaveBeenCalled()
	})
})
