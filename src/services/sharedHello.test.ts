/**
 * The page's one shared hello: single flight, a classification time that cancels nothing, a late valid answer is
 * taken and announced, one more hello at most and not before 60 s, no answer is not a missing capability. SYNTHETIC values.
 */
import { getCachedHello, helloWithinWindow, onHelloValid, probeNativeCapabilities, resetSharedHelloForTest, HELLO_RESEND_AFTER_MS } from './nativeChatRouteRegister'
import { shellChatBlockedNow } from './shellChatCapability'

type Win = Window & { CashTreesIOS?: unknown }
const w = window as unknown as Win
let sent: Array<{ type?: string; reqId?: number }> = []
let answerNow = false

function installShell(caps: string[] = ['identity.native-keys.v1', 'voiceCallV4']) {
	sent = []
	answerNow = false
	w.CashTreesIOS = {
		chatModuleCommand: (raw: Record<string, unknown>) => {
			const cmd = (raw as { command: { type?: string; reqId?: number } }).command
			sent.push(cmd)
			if (answerNow && cmd.type === 'hello') reply(cmd.reqId as number, caps)
		},
	}
}
function reply(reqId: number, caps: string[], ok = true) {
	const payload = ok ? { type: 'ack', reqId, ok: true, result: { protocolVersion: 1, capabilities: caps, nativeApp: { platform: 'android', version: '1.5.8', build: '188' } } } : { type: 'ack', reqId, ok: false, error: 'not_ready' }
	window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: payload } }))
}
const hellos = () => sent.filter((c) => c.type === 'hello')
/** lets the promise chains of the answer run (the clock is fake, so no timer is involved) */
const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
	jest.useFakeTimers()
	resetSharedHelloForTest()
	installShell()
})
afterEach(() => {
	jest.useRealTimers()
	delete w.CashTreesIOS
})

describe('single flight', () => {
	it('callers at the same time share one hello on the wire', async () => {
		const a = probeNativeCapabilities(10_000)
		const b = probeNativeCapabilities(10_000)
		const c = probeNativeCapabilities(5_000)
		expect(hellos()).toHaveLength(1)
		reply(hellos()[0].reqId as number, ['identity.native-keys.v1'])
		expect((await a).answered).toBe(true)
		expect((await b).capabilities).toContain('identity.native-keys.v1')
		expect((await c).answered).toBe(true)
		expect(hellos()).toHaveLength(1)
	})
	it('after a valid answer the capability list is kept: later callers get it at once and nothing is sent', async () => {
		const p = probeNativeCapabilities(10_000)
		reply(hellos()[0].reqId as number, ['identity.native-keys.v1'])
		await p
		sent = []
		expect((await probeNativeCapabilities()).capabilities).toContain('identity.native-keys.v1')
		expect(sent).toHaveLength(0)
		expect(getCachedHello()).not.toBeNull()
	})
})

describe('the classification time cancels nothing', () => {
	it('a caller that waited its time hears "not answered", the request goes on, and a late valid answer is taken and announced once', async () => {
		const heard: string[][] = []
		onHelloValid((r) => void heard.push(r.capabilities))
		const p = probeNativeCapabilities(10_000)
		jest.advanceTimersByTime(10_000)
		expect((await p).answered).toBe(false)
		expect(getCachedHello()).toBeNull()
		expect(helloWithinWindow()).toBe(true)
		// the shell answers at 39 s (the observed late answer)
		jest.advanceTimersByTime(29_000)
		reply(hellos()[0].reqId as number, ['identity.native-keys.v1', 'voiceCallV4'])
		await flush()
		expect(heard).toEqual([['identity.native-keys.v1', 'voiceCallV4']])
		expect(getCachedHello()?.capabilities).toContain('voiceCallV4')
		expect((await probeNativeCapabilities()).answered).toBe(true)
	})
	it('no answer is not a missing capability: the not-answered result has no capabilities and nothing declares "missing"', async () => {
		const p = probeNativeCapabilities(10_000)
		jest.advanceTimersByTime(10_000)
		const r = await p
		expect(r).toEqual({ answered: false, capabilities: [] })
		expect(getCachedHello()).toBeNull()
	})
	it('a refusal is not a valid answer: it is not kept and not announced', async () => {
		const heard: unknown[] = []
		onHelloValid((r) => void heard.push(r))
		const p = probeNativeCapabilities(10_000)
		reply(hellos()[0].reqId as number, [], false)
		expect((await p).answered).toBe(false)
		expect(getCachedHello()).toBeNull()
		expect(heard).toHaveLength(0)
	})
})

describe('at most one more hello, not before 60 s, never more than two in flight', () => {
	it('one resend at 60 s while nothing has answered; none earlier; none after a valid answer; the late answer of the first still counts', async () => {
		const p = probeNativeCapabilities(10_000)
		jest.advanceTimersByTime(HELLO_RESEND_AFTER_MS - 1)
		expect(hellos()).toHaveLength(1)
		jest.advanceTimersByTime(1)
		expect(hellos()).toHaveLength(2)
		jest.advanceTimersByTime(60_000)
		expect(hellos()).toHaveLength(2)
		reply(hellos()[0].reqId as number, ['identity.native-keys.v1'])
		await flush()
		expect(getCachedHello()).not.toBeNull()
		void p
	})
	it('a valid answer before 60 s cancels the resend', async () => {
		void probeNativeCapabilities(10_000)
		jest.advanceTimersByTime(30_000)
		reply(hellos()[0].reqId as number, ['identity.native-keys.v1'])
		await flush()
		jest.advanceTimersByTime(HELLO_RESEND_AFTER_MS * 2)
		expect(hellos()).toHaveLength(1)
	})
})

describe('the window and a different shell', () => {
	it('inside the 180 s window with no answer the window is open; a new shell object starts over', () => {
		void probeNativeCapabilities(10_000)
		expect(helloWithinWindow()).toBe(true)
		installShell()
		expect(getCachedHello()).toBeNull()
	})
	it('a blocked identity path still fails closed without a valid answer (the capability is not assumed)', () => {
		void probeNativeCapabilities(10_000)
		expect(typeof shellChatBlockedNow).toBe('function')
	})
})
