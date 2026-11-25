/**
 * 0.53.49 (plan A, P1): the page side of the two shell actions, with simulated shell replies (the shells are not built yet).
 * Origin negatives, capability, the exact command, the reply mapping, and that no input is logged.
 */
import {
	hasPageInputRecovery,
	isTrustedRecoveryOrigin,
	nativeRecoveryCancel,
	nativeRecoverySubmit,
	setRecoveryOriginForTest,
} from './nativeRecovery'
import * as transport from './shellRecordTransport'
import * as register from './nativeChatRouteRegister'

jest.mock('./shellRecordTransport', () => ({ ...jest.requireActual('./shellRecordTransport'), sendShellActionCommand: jest.fn() }))
jest.mock('./nativeChatRouteRegister', () => ({ ...jest.requireActual('./nativeChatRouteRegister'), probeNativeCapabilities: jest.fn(), nextReqId: () => 41 }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ ...jest.requireActual('@/utils/cashTreesNativeNfc'), getCashTreesNativeNfcHost: () => (globalThis as { __host?: string }).__host ?? 'android' }))

const send = transport.sendShellActionCommand as jest.Mock
const probe = register.probeNativeCapabilities as jest.Mock
const CAP = 'recovery.page-input.v1'
const withCap = () => probe.mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1', CAP] })

const IOS = 'cashtrees-local://localhost/index.html'
const ANDROID = 'https://appassets.androidplatform.net/assets/index.html'
const WEB = 'https://beamio.ca/app/'

beforeEach(() => {
	;(globalThis as { __host?: string }).__host = 'android'
	delete (window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
	send.mockReset()
	probe.mockReset()
	setRecoveryOriginForTest({ href: IOS, topFrame: true })
})
afterAll(() => setRecoveryOriginForTest(null))

describe('isTrustedRecoveryOrigin', () => {
	it.each([IOS, ANDROID, WEB, 'https://beamio.ca/app', 'https://beamio.ca/app/#/restore'])('accepts %s in the top frame', (href) => {
		setRecoveryOriginForTest({ href, topFrame: true })
		expect(isTrustedRecoveryOrigin()).toBe(true)
	})

	it.each([
		'https://beamio.ca.evil.com/app/',
		'https://evil-beamio.ca/app/',
		'https://beamio.ca@evil.com/app/',
		'https://app.beamio.ca/app/',
		'https://beamio.ca/apps/',
		'https://beamio.ca/',
		'https://beamio.ca:8443/app/',
		'http://beamio.ca/app/',
		'https://appassets.androidplatform.net.evil.com/x',
		'cashtrees-local://localhost.evil.com/x',
		'file:///var/mobile/app/index.html',
		'data:text/html,<p>x</p>',
		'blob:https://appassets.androidplatform.net/3f8e',
		'blob:https://beamio.ca/app/3f8e',
		'javascript:void(0)',
		'ftp://beamio.ca/app/',
		'about:blank',
		'not a url',
		'',
	])('refuses %s', (href) => {
		setRecoveryOriginForTest({ href, topFrame: true })
		expect(isTrustedRecoveryOrigin()).toBe(false)
	})

	it.each([IOS, ANDROID, WEB])('refuses a child frame of %s', (href) => {
		setRecoveryOriginForTest({ href, topFrame: false })
		expect(isTrustedRecoveryOrigin()).toBe(false)
	})
})

describe('hasPageInputRecovery', () => {
	it('is true only when the shell declared recovery.page-input.v1', async () => {
		withCap()
		expect(await hasPageInputRecovery()).toBe(true)
		probe.mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		expect(await hasPageInputRecovery()).toBe(false)
		probe.mockResolvedValue({ answered: false, capabilities: [] })
		expect(await hasPageInputRecovery()).toBe(false)
	})
})

describe('nativeRecoverySubmit', () => {
	it('sends the code path with exactly its fields, and ok on an ok ack (no result object needed)', async () => {
		withCap()
		send.mockResolvedValue({ kind: 'payload', payload: { type: 'ack', reqId: 41, ok: true } })
		const out = await nativeRecoverySubmit({ path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' })
		expect(out).toEqual({ ok: true })
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0][0]).toEqual({ type: 'nativeRecoverySubmit', reqId: 41, path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' })
	})

	it('sends the account path with exactly its fields', async () => {
		withCap()
		send.mockResolvedValue({ kind: 'payload', payload: { type: 'ack', reqId: 41, ok: true, result: { code: 'accepted' } } })
		const out = await nativeRecoverySubmit({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })
		expect(out).toEqual({ ok: true })
		expect(send.mock.calls[0][0]).toEqual({ type: 'nativeRecoverySubmit', reqId: 41, path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })
	})

	it('sends nothing without the capability and reports capability_missing (no native page, no not_supported)', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		const out = await nativeRecoverySubmit({ path: 'code', code: 'x' })
		expect(out).toEqual({ ok: false, reason: 'capability_missing' })
		expect(send).not.toHaveBeenCalled()
	})

	it.each(['https://beamio.ca.evil.com/app/', 'file:///x', 'data:text/html,x'])('sends nothing from %s', async (href) => {
		withCap()
		setRecoveryOriginForTest({ href, topFrame: true })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(send).not.toHaveBeenCalled()
	})

	it('sends nothing from a child frame', async () => {
		withCap()
		setRecoveryOriginForTest({ href: IOS, topFrame: false })
		expect(await nativeRecoverySubmit({ path: 'account', name: 'a', password: 'b' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(send).not.toHaveBeenCalled()
	})

	it.each([
		[{ kind: 'origin_refused' }, 'origin_refused'],
		[{ kind: 'timeout' }, 'timeout'],
		[{ kind: 'unavailable' }, 'native_unavailable'],
		[{ kind: 'none' }, 'native_unavailable'],
		[{ kind: 'not_supported' }, 'native_unavailable'],
		[{ kind: 'payload', payload: { type: 'ack', ok: false, error: 'origin_refused' } }, 'origin_refused'],
		[{ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_available' } }, 'not_available'],
		[{ kind: 'payload', payload: { type: 'ack', ok: false, error: 'bad_args' } }, 'bad_args'],
		[{ kind: 'payload', payload: { type: 'ack', ok: false, error: 'surprise' } }, 'bad_ack'],
		[{ kind: 'payload', payload: { type: 'ack' } }, 'bad_ack'],
	])('maps the shell answer %j to %s', async (answer, reason) => {
		withCap()
		send.mockResolvedValue(answer)
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason })
	})

	it('a transport that throws is native_unavailable, and nothing is logged', async () => {
		withCap()
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
		const err = jest.spyOn(console, 'error').mockImplementation(() => undefined)
		const { publishNativePwaLog } = jest.requireMock('@/utils/cashTreesNativePwaLog') as { publishNativePwaLog: jest.Mock }
		publishNativePwaLog.mockClear()
		send.mockRejectedValue(new Error('canary-Passw0rd'))
		expect(await nativeRecoverySubmit({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })).toEqual({ ok: false, reason: 'native_unavailable' })
		expect(log).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
		expect(err).not.toHaveBeenCalled()
		expect(publishNativePwaLog).not.toHaveBeenCalled()
		log.mockRestore()
		warn.mockRestore()
		err.mockRestore()
	})
})

describe('nativeRecoveryCancel', () => {
	it('sends the bare action (no data) from a trusted origin', async () => {
		send.mockResolvedValue({ kind: 'payload', payload: { type: 'ack', reqId: 41, ok: true } })
		expect(await nativeRecoveryCancel()).toEqual({ ok: true })
		expect(send.mock.calls[0][0]).toEqual({ type: 'nativeRecoveryCancel', reqId: 41 })
	})

	it('sends nothing from an untrusted origin, and never throws', async () => {
		setRecoveryOriginForTest({ href: 'https://evil.example/', topFrame: true })
		expect(await nativeRecoveryCancel()).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(send).not.toHaveBeenCalled()
		setRecoveryOriginForTest({ href: IOS, topFrame: true })
		send.mockRejectedValue(new Error('x'))
		await expect(nativeRecoveryCancel()).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
	})
})

describe('iOS adapter (injected capability table, CashTreesIOS actions, cashtreesios answers)', () => {
	const setIos = (caps: unknown, fns: Record<string, unknown>) => {
		;(globalThis as { __host?: string }).__host = 'ios'
		;(window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__ = caps
		;(window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS = fns
	}
	const answer = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent('cashtreesios', { detail }))

	it.each([[{ [CAP]: true }], [[CAP]], [new Set([CAP])]])('reads the capability from the injected table (%j)', async (caps) => {
		setIos(caps, {})
		expect(await hasPageInputRecovery()).toBe(true)
		expect(probe).not.toHaveBeenCalled()
	})

	it.each([[undefined], [{}], [{ [CAP]: false }], [['other']], [{ 'pwa.embedded-ota.v1': true }]])('the capability is missing in %j', async (caps) => {
		setIos(caps, {})
		expect(await hasPageInputRecovery()).toBe(false)
	})

	it('calls CashTreesIOS.nativeRecoverySubmit with exactly the request fields and takes the cashtreesios answer', async () => {
		const fn = jest.fn(() => queueMicrotask(() => answer({ action: 'nativeRecoverySubmit', ok: true })))
		setIos({ [CAP]: true }, { nativeRecoverySubmit: fn })
		const out = await nativeRecoverySubmit({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })
		expect(out).toEqual({ ok: true })
		expect(fn).toHaveBeenCalledWith({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })
		expect(send).not.toHaveBeenCalled()
	})

	it('the code path sends only path and code', async () => {
		const fn = jest.fn(() => queueMicrotask(() => answer({ action: 'nativeRecoverySubmit', ok: true })))
		setIos({ [CAP]: true }, { nativeRecoverySubmit: fn })
		await nativeRecoverySubmit({ path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' })
		expect(fn).toHaveBeenCalledWith({ path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' })
	})

	it.each([
		['origin_refused', 'origin_refused'],
		['not_available', 'not_available'],
		['bad_args', 'bad_args'],
		['surprise', 'bad_ack'],
	])('maps the iOS error %s to %s', async (error, reason) => {
		setIos({ [CAP]: true }, { nativeRecoverySubmit: () => queueMicrotask(() => answer({ action: 'nativeRecoverySubmit', ok: false, error })) })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason })
	})

	it('an answer for another action is ignored; a missing function is capability_missing; nothing is sent without the table', async () => {
		setIos({ [CAP]: true }, { nativeRecoverySubmit: () => queueMicrotask(() => { answer({ action: 'nativeRecoveryCancel', ok: false, error: 'bad_args' }); answer({ action: 'nativeRecoverySubmit', ok: true }) }) })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: true })
		setIos({ [CAP]: true }, {})
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'capability_missing' })
		const fn = jest.fn()
		setIos(undefined, { nativeRecoverySubmit: fn })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'capability_missing' })
		expect(fn).not.toHaveBeenCalled()
	})

	it('sends nothing from an untrusted origin or a child frame', async () => {
		const fn = jest.fn()
		setIos({ [CAP]: true }, { nativeRecoverySubmit: fn })
		setRecoveryOriginForTest({ href: 'https://beamio.ca.evil.com/app/', topFrame: true })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		setRecoveryOriginForTest({ href: IOS, topFrame: false })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(fn).not.toHaveBeenCalled()
	})

	it('only one submit is in flight: a second one is busy and is not sent', async () => {
		const fn = jest.fn()
		setIos({ [CAP]: true }, { nativeRecoverySubmit: fn })
		const first = nativeRecoverySubmit({ path: 'code', code: 'x' })
		await Promise.resolve()
		await Promise.resolve()
		expect(await nativeRecoverySubmit({ path: 'code', code: 'y' })).toEqual({ ok: false, reason: 'busy' })
		answer({ action: 'nativeRecoverySubmit', ok: true })
		expect(await first).toEqual({ ok: true })
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('cancel calls CashTreesIOS.nativeRecoveryCancel with no data', async () => {
		const fn = jest.fn(() => queueMicrotask(() => answer({ action: 'nativeRecoveryCancel', ok: true })))
		setIos({ [CAP]: true }, { nativeRecoveryCancel: fn })
		expect(await nativeRecoveryCancel()).toEqual({ ok: true })
		expect(fn).toHaveBeenCalledWith()
	})
})
