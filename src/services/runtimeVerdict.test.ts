/**
 * @jest-environment node
 */
// The runtime verdict and its default-deny guard (not wired yet). Unit level: synthetic locations and a double for the native transport; no browser, no shell. The negative cases are numbered N1, N2, N4, N5.
import { DEFAULT_ORIGIN_POLICY, OFFICIAL_WEB_ORIGINS, PageKeyRefused, assertPageKeyAllowed, classifyOrigin, createRuntimeArbiter, mayWriteWalletRecords, newHelloNonce, readHelloAck, shellHelloTransport, DEFAULT_HELLO_TIMEOUT_MS, type RuntimeFacts, type RuntimeVerdict, type ShellHello } from './runtimeVerdict'

if (!(globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })

const WEB = 'https://beamio.ca/app/#/home'
const IOS = 'cashtrees-local://localhost/index.html'
const ANDROID = 'https://appassets.androidplatform.net/index.html'
const facts = (href: string, patch: Partial<RuntimeFacts> = {}): RuntimeFacts => ({ href, isTopFrame: true, bridgeLookalike: false, ...patch })
const ack = (hello: ShellHello, platform: string, patch: object = {}) => ({ type: 'beamioShellHelloAck', v: 1, nonce: hello.nonce, platform, appBuild: '104', capabilities: ['chat'], ...patch })

function rig(f: RuntimeFacts) {
	const timers: Array<() => void> = []
	const hellos: Array<{ hello: ShellHello; reply: (m: unknown) => void }> = []
	const arbiter = createRuntimeArbiter({ facts: f, sendHello: (hello, reply) => hellos.push({ hello, reply }), setTimer: (fn) => { timers.push(fn); return 0 } })
	return { arbiter, hellos, timeout: () => timers.splice(0).forEach((fn) => fn()) }
}
const refused = (a: Parameters<typeof assertPageKeyAllowed>[0]) => { try { assertPageKeyAllowed(a); return false } catch (e) { return e instanceof PageKeyRefused } }

describe('origins', () => {
	it('exactly the one official entry is a web origin; the app path only', () => {
		expect(OFFICIAL_WEB_ORIGINS).toEqual(['https://beamio.ca'])
		for (const o of OFFICIAL_WEB_ORIGINS) for (const p of ['/app/', '/app', '/app/index.html?x=1#/chat']) expect(classifyOrigin(facts(o + p))).toEqual({ kind: 'browser' })
		for (const href of ['https://beamio.ca/', 'https://beamio.ca/application/', 'https://beamio.ca/appx']) expect(classifyOrigin(facts(href))).toEqual({ kind: 'unknown', reason: 'path_outside_app' })
	})
	it('every other origin is unknown, look-alikes and the former domain included', () => {
		for (const href of ['https://www.beamio.ca/app/', 'https://beamio.app/app/', 'https://www.beamio.app/app/', 'http://beamio.ca/app/', 'https://beamio.ca:8443/app/', 'https://biz.beamio.ca/app/', 'https://pos.beamio.ca/app/', 'https://beamio.ca.evil.test/app/', 'https://evil-beamio.ca/app/', 'http://localhost:3000/app/', 'http://127.0.0.1:8082/app/', 'file:///app/index.html', 'data:text/html,x', 'blob:https://beamio.ca/uuid', 'cashtrees-local://other/index.html', 'http://appassets.androidplatform.net/index.html', 'https://sub.appassets.androidplatform.net/']) {
			expect([href, classifyOrigin(facts(href)).kind]).toEqual([href, 'unknown'])
		}
		expect(classifyOrigin(facts('https://user@beamio.ca/app/'))).toEqual({ kind: 'unknown', reason: 'bad_location' })
		expect(classifyOrigin(facts('not a url'))).toEqual({ kind: 'unknown', reason: 'bad_location' })
	})
	it('a framed page is unknown on every origin', () => {
		for (const href of [WEB, IOS, ANDROID]) expect(classifyOrigin(facts(href, { isTopFrame: false }))).toEqual({ kind: 'unknown', reason: 'framed' })
	})
	it('a test origin counts only when a policy names it', () => {
		expect(classifyOrigin(facts('http://127.0.0.1:8082/app/'), { ...DEFAULT_ORIGIN_POLICY, webOrigins: ['http://127.0.0.1:8082'] })).toEqual({ kind: 'browser' })
	})
})

describe('before the decision', () => {
	it('everything is refused: no arbiter, or not resolved yet, on any origin', () => {
		expect(refused(null)).toBe(true)
		for (const href of [WEB, IOS, ANDROID]) {
			const { arbiter } = rig(facts(href))
			expect(refused(arbiter)).toBe(true)
			expect(mayWriteWalletRecords(arbiter.current())).toBe(false)
		}
	})
})

describe('N1: forged bridge objects on a web origin', () => {
	it('present at start: unknown, no hello is sent, no key path, no record write', async () => {
		const r = rig(facts(WEB, { bridgeLookalike: true }))
		expect(await r.arbiter.resolve()).toEqual({ kind: 'unknown', reason: 'bridge_on_web_origin' })
		expect(r.hellos).toHaveLength(0)
		expect(refused(r.arbiter)).toBe(true)
		expect(mayWriteWalletRecords(r.arbiter.current())).toBe(false)
		expect(await r.arbiter.retry()).toEqual({ kind: 'unknown', reason: 'bridge_on_web_origin' })
		expect(r.hellos).toHaveLength(0)
	})
	it('the facts are read when the arbiter is made: a change before resolve() does not count', async () => {
		const f = facts(ANDROID)
		const r = rig(f)
		f.href = WEB
		const p = r.arbiter.resolve()
		r.timeout()
		expect(await p).toEqual({ kind: 'unknown', reason: 'hello_timeout' })
		expect(refused(r.arbiter)).toBe(true)
	})
	it('added after the decision: nothing changes (the facts were read once)', async () => {
		const f = facts(WEB)
		const r = rig(f)
		await r.arbiter.resolve()
		f.bridgeLookalike = true; f.href = ANDROID
		await r.arbiter.retry()
		expect(r.arbiter.current()).toEqual({ kind: 'browser' })
		expect(r.hellos).toHaveLength(0)
		expect(refused(r.arbiter)).toBe(false)
	})
})

describe('N2: a replayed or malformed answer', () => {
	it('an answer to another hello, an old one, or a wrong shape never makes a shell', async () => {
		const first = rig(facts(ANDROID))
		const p1 = first.arbiter.resolve()
		const old = ack(first.hellos[0]!.hello, 'android')
		first.hellos[0]!.reply(old)
		expect((await p1).kind).toBe('shell')
		const r = rig(facts(ANDROID))
		const p = r.arbiter.resolve()
		const h = r.hellos[0]!.hello
		expect(h.nonce).toMatch(/^[0-9a-f]{64}$/)
		expect(h.nonce).not.toBe(first.hellos[0]!.hello.nonce)
		for (const bad of [old, null, 'ok', {}, ack(h, 'android', { nonce: '0'.repeat(64) }), ack(h, 'android', { v: 2 }), ack(h, 'android', { type: 'beamioShellHello' }), ack(h, 'ios'), ack(h, 'android', { appBuild: '' }), ack(h, 'android', { appBuild: 104 }), ack(h, 'android', { capabilities: 'chat' }), ack(h, 'android', { capabilities: [1] }), ack(h, 'android', { nonce: undefined })]) r.hellos[0]!.reply(bad)
		expect(r.arbiter.current()).toEqual({ kind: 'unknown', reason: 'not_decided' })
		r.timeout()
		expect(await p).toEqual({ kind: 'unknown', reason: 'hello_timeout' })
	})
	it('a new nonce every time', () => { expect(new Set(Array.from({ length: 50 }, newHelloNonce)).size).toBe(50) })
	it('the answer is read exactly', () => { const hello = { type: 'beamioShellHello' as const, v: 1 as const, nonce: 'a'.repeat(64) }; expect(readHelloAck(ack(hello, 'ios'), hello.nonce, 'ios')).toEqual({ kind: 'shell', platform: 'ios', appBuild: '104', capabilities: ['chat'] }) })
})

describe('N4: a real shell origin whose bridge fails', () => {
	for (const [label, href] of [['iOS', IOS], ['Android', ANDROID]] as const) {
		it(`${label}: no answer: unknown, never a browser, no key path, no record write; retry asks again`, async () => {
			const r = rig(facts(href))
			const p = r.arbiter.resolve()
			r.timeout()
			expect(await p).toEqual({ kind: 'unknown', reason: 'hello_timeout' })
			expect(refused(r.arbiter)).toBe(true)
			expect(mayWriteWalletRecords(r.arbiter.current())).toBe(false)
			const again = r.arbiter.retry()
			expect(r.hellos).toHaveLength(2)
			r.hellos[1]!.reply(ack(r.hellos[1]!.hello, label === 'iOS' ? 'ios' : 'android'))
			expect((await again).kind).toBe('shell')
			expect(refused(r.arbiter)).toBe(true) // a shell never gets the page-key path
			expect(mayWriteWalletRecords(r.arbiter.current())).toBe(true)
		})
	}
	it('a late valid answer turns unknown into that shell, never into a browser', async () => {
		const r = rig(facts(IOS))
		const p = r.arbiter.resolve()
		r.timeout()
		await p
		r.hellos[0]!.reply(ack(r.hellos[0]!.hello, 'ios'))
		expect(r.arbiter.current().kind).toBe('shell')
		expect(refused(r.arbiter)).toBe(true)
	})
	it('a transport that throws is unknown', async () => {
		const arbiter = createRuntimeArbiter({ facts: facts(ANDROID), sendHello: () => { throw new Error('no bridge') }, setTimer: () => 0 })
		expect(await arbiter.resolve()).toEqual({ kind: 'unknown', reason: 'hello_failed' })
		expect(refused(arbiter)).toBe(true)
	})
	it('a missing bridge object changes nothing: a shell origin with nothing on the page is still not a browser', async () => {
		const r = rig(facts(ANDROID, { bridgeLookalike: false }))
		const p = r.arbiter.resolve()
		r.timeout()
		expect((await p).kind).toBe('unknown')
	})
})

describe('N5: after a shell is decided', () => {
	it('later answers, changed facts and retries do not downgrade or change it', async () => {
		const f = facts(ANDROID, { bridgeLookalike: true })
		const r = rig(f)
		const p = r.arbiter.resolve()
		r.hellos[0]!.reply(ack(r.hellos[0]!.hello, 'android'))
		const decided: RuntimeVerdict = await p
		f.bridgeLookalike = false; f.href = WEB
		r.timeout()
		r.hellos[0]!.reply(ack(r.hellos[0]!.hello, 'android', { appBuild: '999' }))
		await r.arbiter.retry()
		await r.arbiter.resolve()
		expect(r.arbiter.current()).toEqual(decided)
		expect(r.hellos).toHaveLength(1)
		expect(refused(r.arbiter)).toBe(true)
	})
	it('two callers resolve once', async () => {
		const r = rig(facts(IOS))
		const a = r.arbiter.resolve(); const b = r.arbiter.resolve()
		r.hellos[0]!.reply(ack(r.hellos[0]!.hello, 'ios'))
		expect(await a).toEqual(await b)
		expect(r.hellos).toHaveLength(1)
	})
})

describe('the native entries', () => {
	const run = async (platform: 'ios' | 'android', page: unknown) => {
		const timers: Array<() => void> = []
		const waits: number[] = []
		const arbiter = createRuntimeArbiter({ facts: facts(platform === 'ios' ? IOS : ANDROID), sendHello: shellHelloTransport(platform, page), setTimer: (fn, ms) => { timers.push(fn); waits.push(ms); return 0 } })
		const p = arbiter.resolve()
		await new Promise((r) => setTimeout(r, 5))
		timers.splice(0).forEach((fn) => fn())
		expect(waits).toEqual([DEFAULT_HELLO_TIMEOUT_MS])
		return p
	}
	const iosPage = (answer: (m: ShellHello) => unknown) => ({ webkit: { messageHandlers: { beamioShellHello: { postMessage: answer } } } })
	const androidPage = (answer: (m: ShellHello) => string | null) => {
		const channel: { onmessage: null | ((e: { data: string }) => void); postMessage: (s: string) => void; sent: string[] } = { onmessage: null, sent: [], postMessage(s) { this.sent.push(s); const reply = answer(JSON.parse(s)); if (reply !== null) queueMicrotask(() => this.onmessage?.({ data: reply })) } }
		return { __beamioShellHello: channel }
	}
	it('iOS: the promised answer decides the shell', async () => {
		expect((await run('ios', iosPage(async (h) => ack(h, 'ios')))).kind).toBe('shell')
	})
	it('Android: the answer text at onmessage decides the shell', async () => {
		expect((await run('android', androidPage((h) => JSON.stringify(ack(h, 'android'))))).kind).toBe('shell')
	})
	it('no entry, no promise, a refusal, silence or text that is not JSON: unknown', async () => {
		for (const [platform, page] of [['ios', {}], ['ios', undefined], ['ios', iosPage(() => undefined)], ['ios', iosPage(async () => { throw new Error('refused') })], ['android', {}], ['android', androidPage(() => null)], ['android', androidPage(() => '{bad')], ['android', { __beamioShellHello: { postMessage: 'x' } }]] as const) {
			const v = await run(platform, page)
			expect(v.kind).toBe('unknown')
		}
	})
	it('the old bridge objects are not an entry', async () => {
		expect((await run('android', { CashTreesAndroid: { beamioShellHello: () => 1 }, BeamioChat: {}, BeamioShell: {} })).kind).toBe('unknown')
		expect((await run('ios', { webkit: { messageHandlers: { CashTreesIOS: { postMessage: async (h: ShellHello) => ack(h, 'ios') } } } })).kind).toBe('unknown')
	})
})
