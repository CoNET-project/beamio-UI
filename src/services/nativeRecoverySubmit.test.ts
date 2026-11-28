/**
 * 0.53.49 (plan A, P1): the page side of the two shell actions, with simulated shell replies (the shells are not built yet).
 * Origin negatives, capability, the exact command, the reply mapping, and that no input is logged.
 */
import {
	hasPageInputRecovery,
	isTrustedRecoveryOrigin,
	nativeRecoveryCancel,
	nativeRecoverySubmit,
	onNativeRecoveryResult,
	setRecoveryOriginForTest,
} from './nativeRecovery'
import * as channel from '@/utils/beamioShellChannel'
import * as register from './nativeChatRouteRegister'

jest.mock('@/utils/beamioShellChannel', () => ({ ...jest.requireActual('@/utils/beamioShellChannel'), hasBeamioShell: jest.fn(), requestBeamioShell: jest.fn() }))
jest.mock('./nativeChatRouteRegister', () => ({ ...jest.requireActual('./nativeChatRouteRegister'), probeNativeCapabilities: jest.fn(), nextReqId: () => 41 }))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))
jest.mock('@/utils/cashTreesNativeNfc', () => ({ ...jest.requireActual('@/utils/cashTreesNativeNfc'), getCashTreesNativeNfcHost: () => (globalThis as { __host?: string }).__host ?? 'android' }))

const request = channel.requestBeamioShell as jest.Mock
const hasShell = channel.hasBeamioShell as jest.Mock
const probe = register.probeNativeCapabilities as jest.Mock
const CAP = 'recovery.page-input.v1'
/** Android: shellCapabilities answers the list; every other action answers per test. */
const ackFor = (submit: unknown, caps: unknown = { ok: true, result: { capabilities: [CAP] } }) =>
	request.mockImplementation(async (action: string) => (action === 'shellCapabilities' ? caps : submit))
const withCap = (submit: unknown = { ok: true }) => ackFor(submit)
const sent = () => request.mock.calls.filter((c) => c[0] !== 'shellCapabilities')

const IOS = 'cashtrees-local://localhost/index.html'
const ANDROID = 'https://appassets.androidplatform.net/assets/index.html'
const WEB = 'https://beamio.ca/app/'

beforeEach(() => {
	;(globalThis as { __host?: string }).__host = 'android'
	delete (window as unknown as { __CT_IOS_CAPS__?: unknown }).__CT_IOS_CAPS__
	delete (window as unknown as { CashTreesIOS?: unknown }).CashTreesIOS
	request.mockReset()
	hasShell.mockReset()
	hasShell.mockReturnValue(true)
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

describe('hasPageInputRecovery (Android: shellCapabilities on window.BeamioShell)', () => {
	it('is true only when the shell answers the capability in its list', async () => {
		ackFor({ ok: true })
		expect(await hasPageInputRecovery()).toBe(true)
		expect(request.mock.calls[0]).toEqual(['shellCapabilities', {}, expect.any(Number)])
		ackFor({ ok: true }, { ok: true, result: { capabilities: ['other'] } })
		expect(await hasPageInputRecovery()).toBe(false)
		ackFor({ ok: true }, { ok: true, result: { capabilities: [CAP] } })
		expect(await hasPageInputRecovery()).toBe(true)
	})

	it('an old shell (unknown_command), a timeout, or no channel is capability missing; no hello is used', async () => {
		ackFor({ ok: true }, { ok: false, error: 'unknown_command' })
		expect(await hasPageInputRecovery()).toBe(false)
		ackFor({ ok: true }, { ok: false, error: 'timeout' })
		expect(await hasPageInputRecovery()).toBe(false)
		request.mockReset()
		hasShell.mockReturnValue(false)
		expect(await hasPageInputRecovery()).toBe(false)
		expect(request).not.toHaveBeenCalled()
		expect(probe).not.toHaveBeenCalled()
	})
})

describe('nativeRecoverySubmit (Android)', () => {
	it('sends the code path with exactly its args, and ok on an ok ack', async () => {
		withCap()
		const out = await nativeRecoverySubmit({ path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' })
		expect(out).toEqual({ ok: true })
		expect(sent()).toHaveLength(1)
		expect(sent()[0].slice(0, 2)).toEqual(['nativeRecoverySubmit', { path: 'code', code: 'a1B2c3D4e5F6g7H8i9J0kL' }])
	})

	it('sends the account path with exactly its args', async () => {
		withCap()
		expect(await nativeRecoverySubmit({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })).toEqual({ ok: true })
		expect(sent()[0].slice(0, 2)).toEqual(['nativeRecoverySubmit', { path: 'account', name: 'synthtag', password: 'canary-Passw0rd' }])
	})

	it('sends nothing without the capability and reports capability_missing (no native page, no not_supported)', async () => {
		ackFor({ ok: true }, { ok: false, error: 'unknown_command' })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'capability_missing' })
		expect(sent()).toHaveLength(0)
	})

	it.each(['https://beamio.ca.evil.com/app/', 'file:///x', 'data:text/html,x', 'blob:https://appassets.androidplatform.net/3f8e', 'javascript:void(0)'])('sends nothing from %s (not even the capability question)', async (href) => {
		withCap()
		setRecoveryOriginForTest({ href, topFrame: true })
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(request).not.toHaveBeenCalled()
	})

	it('sends nothing from a child frame', async () => {
		withCap()
		setRecoveryOriginForTest({ href: IOS, topFrame: false })
		expect(await nativeRecoverySubmit({ path: 'account', name: 'a', password: 'b' })).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(request).not.toHaveBeenCalled()
	})

	it.each([
		[{ ok: false, error: 'origin_refused' }, 'origin_refused'],
		[{ ok: false, error: 'not_available' }, 'not_available'],
		[{ ok: false, error: 'bad_args' }, 'bad_args'],
		[{ ok: false, error: 'timeout' }, 'timeout'],
		[{ ok: false, error: 'not_supported' }, 'capability_missing'],
		[{ ok: false, error: 'bridge_missing' }, 'capability_missing'],
		[{ ok: false, error: 'surprise' }, 'bad_ack'],
	])('maps the shell ack %j to %s', async (ack, reason) => {
		withCap(ack)
		expect(await nativeRecoverySubmit({ path: 'code', code: 'x' })).toEqual({ ok: false, reason })
	})

	it('only one submit is in flight: a second one is busy and is not sent', async () => {
		let release: (v: unknown) => void = () => undefined
		request.mockImplementation((action: string) => (action === 'shellCapabilities' ? Promise.resolve({ ok: true, result: { capabilities: [CAP] } }) : new Promise((r) => { release = r })))
		const first = nativeRecoverySubmit({ path: 'code', code: 'x' })
		await new Promise((r) => setTimeout(r, 0))
		expect(await nativeRecoverySubmit({ path: 'code', code: 'y' })).toEqual({ ok: false, reason: 'busy' })
		release({ ok: true })
		expect(await first).toEqual({ ok: true })
		expect(sent()).toHaveLength(1)
	})

	it('a channel that throws never logs the input', async () => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
		const err = jest.spyOn(console, 'error').mockImplementation(() => undefined)
		const { publishNativePwaLog } = jest.requireMock('@/utils/cashTreesNativePwaLog') as { publishNativePwaLog: jest.Mock }
		publishNativePwaLog.mockClear()
		request.mockImplementation(async (action: string) => {
			if (action === 'shellCapabilities') return { ok: true, result: { capabilities: [CAP] } }
			return { ok: false, error: 'canary-Passw0rd' }
		})
		const out = await nativeRecoverySubmit({ path: 'account', name: 'synthtag', password: 'canary-Passw0rd' })
		expect(out).toEqual({ ok: false, reason: 'bad_ack' })
		expect(JSON.stringify(out)).not.toContain('canary')
		expect(log).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
		expect(err).not.toHaveBeenCalled()
		expect(publishNativePwaLog).not.toHaveBeenCalled()
		log.mockRestore()
		warn.mockRestore()
		err.mockRestore()
	})
})

describe('the page-input submit and its result event, either order', () => {
	const emit = (event: Record<string, unknown>) => window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } }))
	it('a result that reaches the page BEFORE the ack of the submit is delivered at once (the result path does not wait for the ack); the submit then resolves ok; a second submit meanwhile is busy', async () => {
		setRecoveryOriginForTest({ href: ANDROID, topFrame: true })
		let release: (v: unknown) => void = () => undefined
		request.mockImplementation((action: string) => (action === 'shellCapabilities' ? Promise.resolve({ ok: true, result: { capabilities: [CAP] } }) : new Promise((r) => { release = r })))
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		const first = nativeRecoverySubmit({ path: 'code', code: 'x'.repeat(10) })
		await new Promise((r) => setTimeout(r, 0))
		emit({ type: 'nativeRecoveryResult', code: 'bad_pin' }) // the shell's result comes first
		expect(got).toEqual(['bad_pin'])
		await expect(nativeRecoverySubmit({ path: 'code', code: 'y'.repeat(10) })).resolves.toEqual({ ok: false, reason: 'busy' })
		release({ ok: true }) // the ack comes after the result
		await expect(first).resolves.toEqual({ ok: true })
		expect(got).toEqual(['bad_pin']) // not delivered twice, not lost
		off()
		release = () => undefined
	})
	it('ack first, result after: the same single delivery', async () => {
		setRecoveryOriginForTest({ href: ANDROID, topFrame: true })
		withCap({ ok: true })
		const got: string[] = []
		const off = onNativeRecoveryResult((r) => got.push(r.code))
		await expect(nativeRecoverySubmit({ path: 'code', code: 'x'.repeat(10) })).resolves.toEqual({ ok: true })
		emit({ type: 'nativeRecoveryResult', code: 'bad_pin' })
		expect(got).toEqual(['bad_pin'])
		off()
	})
})

describe('nativeRecoveryCancel (Android)', () => {
	it('sends the bare action (no args) from a trusted origin', async () => {
		request.mockResolvedValue({ ok: true })
		expect(await nativeRecoveryCancel()).toEqual({ ok: true })
		expect(request.mock.calls[0].slice(0, 2)).toEqual(['nativeRecoveryCancel', {}])
	})

	it('sends nothing from an untrusted origin, and a refusal is mapped, never thrown', async () => {
		setRecoveryOriginForTest({ href: 'https://evil.example/', topFrame: true })
		expect(await nativeRecoveryCancel()).toEqual({ ok: false, reason: 'untrusted_origin' })
		expect(request).not.toHaveBeenCalled()
		setRecoveryOriginForTest({ href: IOS, topFrame: true })
		request.mockResolvedValue({ ok: false, error: 'not_available' })
		await expect(nativeRecoveryCancel()).resolves.toEqual({ ok: false, reason: 'not_available' })
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
		expect(request).not.toHaveBeenCalled()
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
