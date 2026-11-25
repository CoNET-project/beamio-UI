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
const mount = async (opts: { typeTag?: boolean; resume?: { eoa: string; tag: string } } = {}) => {
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

	it('pressing next runs step 1 with the locked tag, and the normal three steps follow with the recover code shown (no N1 notice)', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalledWith(TAG), { timeout: 5000 })
		await act(async () => emitCreate({ code: 'ok', eoa: WALLET }))
		await waitFor(() => expect(spc.sendAccountCreateRegister.mock.calls[0]?.[0]).toMatchObject({ tag: TAG, password: PWD }), { timeout: 5000 })
		expect(await screen.findByTestId('recover-code')).toBeTruthy()
		expect(noticeShown()).toBeNull()
	})

	it('there is no way to put the lock aside on the page (no later / skip control)', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		expect(screen.queryByText(/later|skip/i)).toBeNull()
	})
})

describe('D2: the wallet step 1 answers for must be the one the gate found', () => {
	it('another wallet: the lock is dropped, no record is written for it, nothing is registered, try-later copy', async () => {
		seedRecord()
		await mount({ resume: RESUME })
		await press()
		await waitFor(() => expect(nr.nativeAccountCreateOpen).toHaveBeenCalled(), { timeout: 5000 })
		const OTHER = '0x' + '2'.repeat(40)
		await act(async () => emitCreate({ code: 'ok', eoa: OTHER }))
		expect(await screen.findByText('create_account_try_later')).toBeTruthy()
		expect(spc.sendAccountCreateRegister).not.toHaveBeenCalled()
		expect(beamio.postAddUserPayload).not.toHaveBeenCalled()
		const all = JSON.parse(localStorage.getItem(KEY) ?? '{}')
		expect(all[OTHER]).toBeUndefined()
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
