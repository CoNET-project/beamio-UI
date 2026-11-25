/**
 * 0.53.50: the trusted adapter of onboarding create (accountCreateRegister, secureScreen, account.page-create.v1), with simulated shell replies.
 */
import { hasPageCreate, sendAccountCreateRegister, setSecureScreen } from './shellPageCreate'
import { setRecoveryOriginForTest } from './nativeRecovery'
import * as channel from '@/utils/beamioShellChannel'

jest.mock('@/utils/beamioShellChannel', () => ({ ...jest.requireActual('@/utils/beamioShellChannel'), hasBeamioShell: jest.fn(), requestBeamioShell: jest.fn() }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ ...jest.requireActual('@/utils/cashTreesNativeNfc'), getCashTreesNativeNfcHost: () => (globalThis as { __host?: string }).__host ?? 'android' }))

const request = channel.requestBeamioShell as jest.Mock
const hasShell = channel.hasBeamioShell as jest.Mock
const CAP = 'account.page-create.v1'
const IOS = 'cashtrees-local://localhost/index.html'
const ANDROID = 'https://appassets.androidplatform.net/assets/index.html'

const RESULT = { accountName: 'synthtag', wallet: '0x' + '1'.repeat(40), signMessage: '0x' + 'a'.repeat(130), recover: [{ hash: 'h', encrypto: 'e' }], recoverCodeBase58: 'Abc123' }

/** Android: shellCapabilities answers per `caps`; every other action answers `answer`. */
const android = (answer: unknown, caps: unknown = { ok: true, result: { capabilities: [CAP] } }) =>
	request.mockImplementation(async (action: string) => (action === 'shellCapabilities' ? caps : answer))

beforeEach(() => {
	;(globalThis as { __host?: string }).__host = 'android'
	delete (window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
	request.mockReset()
	hasShell.mockReset()
	hasShell.mockReturnValue(true)
	setRecoveryOriginForTest({ href: ANDROID, topFrame: true })
})
afterAll(() => setRecoveryOriginForTest(null))

describe('capability account.page-create.v1', () => {
	it('Android: only a shellCapabilities answer that lists it counts; an old shell, a timeout and no channel do not', async () => {
		android({ ok: true })
		expect(await hasPageCreate()).toBe(true)
		android({ ok: true }, { ok: true, result: { capabilities: ['recovery.page-input.v1'] } })
		expect(await hasPageCreate()).toBe(false)
		android({ ok: true }, { ok: false, error: 'unknown_command' })
		expect(await hasPageCreate()).toBe(false)
		hasShell.mockReturnValue(false)
		expect(await hasPageCreate()).toBe(false)
	})

	it('iOS: the injected table', async () => {
		;(globalThis as { __host?: string }).__host = 'ios'
		;(window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__ = { [CAP]: true }
		expect(await hasPageCreate()).toBe(true)
		;(window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__ = { 'recovery.page-input.v1': true }
		expect(await hasPageCreate()).toBe(false)
	})
})

describe('sendAccountCreateRegister (Android window.BeamioShell)', () => {
	it('sends exactly {tag, password} and wraps the result into the envelope the register parser reads', async () => {
		android({ ok: true, result: RESULT })
		const out = await sendAccountCreateRegister({ reqId: 7, tag: 'synthtag', password: 'canary-Passw0rd1' })
		expect(out).toEqual({ type: 'ack', ok: true, reqId: 7, result: RESULT })
		const call = request.mock.calls.find((c) => c[0] === 'accountCreateRegister')
		expect(call?.[1]).toEqual({ tag: 'synthtag', password: 'canary-Passw0rd1' })
	})

	it('an SDK error code passes through as a failure envelope', async () => {
		android({ ok: false, error: 'tag_taken' })
		expect(await sendAccountCreateRegister({ reqId: 7, tag: 'a', password: 'b' })).toEqual({ type: 'ack', ok: false, reqId: 7, error: 'tag_taken' })
	})

	it.each(['timeout', 'origin_refused', 'unknown_command', 'bad_args', 'not_supported', 'bridge_missing'])('the shell-level failure %s is null (unavailable), not an SDK answer', async (error) => {
		android({ ok: false, error })
		expect(await sendAccountCreateRegister({ reqId: 7, tag: 'a', password: 'b' })).toBeNull()
	})

	it('nothing is sent without the capability, from an untrusted origin, or from a child frame', async () => {
		android({ ok: true, result: RESULT }, { ok: true, result: { capabilities: [] } })
		expect(await sendAccountCreateRegister({ reqId: 7, tag: 'a', password: 'b' })).toBeNull()
		android({ ok: true, result: RESULT })
		for (const href of ['https://beamio.ca.evil.com/app/', 'file:///x', 'blob:https://appassets.androidplatform.net/x']) {
			setRecoveryOriginForTest({ href, topFrame: true })
			expect(await sendAccountCreateRegister({ reqId: 7, tag: 'a', password: 'b' })).toBeNull()
		}
		setRecoveryOriginForTest({ href: ANDROID, topFrame: false })
		expect(await sendAccountCreateRegister({ reqId: 7, tag: 'a', password: 'b' })).toBeNull()
		expect(request.mock.calls.filter((c) => c[0] === 'accountCreateRegister')).toHaveLength(0)
	})

	it('never logs the input', async () => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { publishNativePwaLog } = jest.requireMock('@/utils/cashTreesNativePwaLog') as { publishNativePwaLog: jest.Mock }
		android({ ok: true, result: RESULT })
		await sendAccountCreateRegister({ reqId: 7, tag: 'synthtag', password: 'canary-Passw0rd1' })
		expect(log).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
		expect(publishNativePwaLog).not.toHaveBeenCalled()
		log.mockRestore()
		warn.mockRestore()
	})
})

describe('sendAccountCreateRegister (iOS 115: CashTreesIOS + SDK ack in chatModuleEvent)', () => {
	const setIos = (fn: unknown) => {
		;(globalThis as { __host?: string }).__host = 'ios'
		setRecoveryOriginForTest({ href: IOS, topFrame: true })
		;(window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__ = { [CAP]: true }
		;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = { accountCreateRegister: fn, secureScreen: fn }
	}
	const ack = (event: Record<string, unknown>) => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } }))

	it('calls CashTreesIOS.accountCreateRegister with exactly {reqId, tag, password} and pairs the SDK ack by reqId', async () => {
		const fn = jest.fn(() => queueMicrotask(() => {
			ack({ type: 'ack', reqId: 999, ok: true, result: { other: 1 } }) // another request's ack is ignored
			ack({ type: 'ack', reqId: 9, ok: true, result: RESULT })
		}))
		setIos(fn)
		expect(await sendAccountCreateRegister({ reqId: 9, tag: 'synthtag', password: 'canary-Passw0rd1' })).toEqual({ type: 'ack', ok: true, reqId: 9, result: RESULT })
		expect(fn).toHaveBeenCalledWith({ reqId: 9, tag: 'synthtag', password: 'canary-Passw0rd1' })
	})

	it('an SDK error passes through; the shell refusals origin_refused and bad_request are unavailable (null)', async () => {
		for (const [error, want] of [['seal_failed', { type: 'ack', ok: false, reqId: 9, error: 'seal_failed' }], ['tag_taken', { type: 'ack', ok: false, reqId: 9, error: 'tag_taken' }], ['origin_refused', null], ['bad_request', null]] as const) {
			setIos(jest.fn(() => queueMicrotask(() => ack({ type: 'ack', reqId: 9, ok: false, error }))))
			expect(await sendAccountCreateRegister({ reqId: 9, tag: 'a', password: 'b' })).toEqual(want)
		}
	})

	it('an event of another action or a non-ack is ignored; a missing shim is null; nothing is sent from an untrusted origin', async () => {
		const fn = jest.fn(() => queueMicrotask(() => {
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'secureScreen', ok: true } }))
			ack({ type: 'other', reqId: 9, ok: true })
			ack({ type: 'ack', reqId: 9, ok: true, result: RESULT })
		}))
		setIos(fn)
		expect(await sendAccountCreateRegister({ reqId: 9, tag: 'a', password: 'b' })).toEqual({ type: 'ack', ok: true, reqId: 9, result: RESULT })
		setIos(undefined)
		expect(await sendAccountCreateRegister({ reqId: 9, tag: 'a', password: 'b' })).toBeNull()
		const fn2 = jest.fn()
		setIos(fn2)
		setRecoveryOriginForTest({ href: 'https://beamio.ca.evil.com/app/', topFrame: true })
		expect(await sendAccountCreateRegister({ reqId: 9, tag: 'a', password: 'b' })).toBeNull()
		expect(fn2).not.toHaveBeenCalled()
	})
})

describe('setSecureScreen', () => {
	it('Android: sends {on} over BeamioShell; the answer decides the return', async () => {
		request.mockResolvedValue({ ok: true })
		expect(await setSecureScreen(true)).toBe(true)
		expect(request.mock.calls[0].slice(0, 2)).toEqual(['secureScreen', { on: true }])
		request.mockResolvedValue({ ok: false, error: 'unknown_command' })
		expect(await setSecureScreen(false)).toBe(false)
	})

	it('iOS: CashTreesIOS.secureScreen({on})', async () => {
		;(globalThis as { __host?: string }).__host = 'ios'
		setRecoveryOriginForTest({ href: IOS, topFrame: true })
		const fn = jest.fn(() => queueMicrotask(() => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'secureScreen', ok: true } }))))
		;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = { secureScreen: fn }
		expect(await setSecureScreen(true)).toBe(true)
		expect(fn).toHaveBeenCalledWith({ on: true })
	})

	it('nothing is sent from an untrusted origin; never throws', async () => {
		setRecoveryOriginForTest({ href: 'https://evil.example/', topFrame: true })
		expect(await setSecureScreen(true)).toBe(false)
		expect(request).not.toHaveBeenCalled()
		setRecoveryOriginForTest({ href: ANDROID, topFrame: true })
		request.mockRejectedValue(new Error('x'))
		await expect(setSecureScreen(true)).resolves.toBe(false)
	})
})
