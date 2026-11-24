/**
 * A late valid hello is taken by its consumers ("late is not dead"): the chat state, the capability status, the
 * call capability. "Not answered" is never "missing". SYNTHETIC values.
 */
import { resetSharedHelloForTest } from './nativeChatRouteRegister'
import { ensureShellChatState, onShellChatCapabilityResolved, resetShellChatCapabilityForTest } from './shellChatCapability'
import { getShellChatUiState, setShellChatUiState } from './shellChatUiState'
import { getNativeIdentityCapability, setNativeIdentityCapability } from './nativeIdentityProbeRetry'

jest.mock('../utils/cashTreesNativeNfc', () => ({ ...jest.requireActual('../utils/cashTreesNativeNfc'), isCashTreesNativeWebView: () => true }))
jest.mock('../utils/shellBuildFlag', () => ({ isShellBuildKind: () => true }))
jest.mock('./shellContext', () => ({ isShellContext: () => true }))

type Win = Window & { CashTreesIOS?: unknown }
const w = window as unknown as Win
let sent: Array<{ type?: string; reqId?: number }> = []
const reply = (reqId: number, caps: string[], withApp = true) =>
	window.dispatchEvent(
		new CustomEvent('cashtreesios', {
			detail: { action: 'chatModuleEvent', event: { type: 'ack', reqId, ok: true, result: { protocolVersion: 1, capabilities: caps, ...(withApp ? { nativeApp: { platform: 'android', version: '1.5.8', build: '188' } } : {}) } } },
		}),
	)
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
	jest.useFakeTimers()
	resetSharedHelloForTest()
	resetShellChatCapabilityForTest()
	sent = []
	w.CashTreesIOS = { chatModuleCommand: (p: Record<string, unknown>) => void sent.push((p as { command: { type?: string; reqId?: number } }).command) }
	setShellChatUiState('chat_unavailable')
	setNativeIdentityCapability('unknown')
})
afterEach(() => {
	jest.useRealTimers()
	delete w.CashTreesIOS
})

describe('the chat state', () => {
	it('no answer in the classification time: the chat stays blocked (fail closed) but the capability is NOT "missing"; a late valid hello with the capability settles it to native_chat and tells the listeners', async () => {
		const resolved: string[] = []
		onShellChatCapabilityResolved((s) => void resolved.push(s))
		const p = ensureShellChatState()
		jest.advanceTimersByTime(10_000)
		await flush()
		expect(await p).toBe('chat_unavailable')
		expect(getNativeIdentityCapability()).not.toBe('missing')
		// the shell answers late (the observed 39 s)
		jest.advanceTimersByTime(29_000)
		const hello = sent.find((c) => c.type === 'hello')
		reply(hello?.reqId as number, ['identity.native-keys.v1'])
		await flush()
		expect(getShellChatUiState()).toBe('native_chat')
		expect(getNativeIdentityCapability()).toBe('declared')
		expect(resolved).toContain('native_chat')
	})
	it('only a valid hello WITHOUT the capability makes it "missing" (the update text)', async () => {
		void ensureShellChatState()
		jest.advanceTimersByTime(1_000)
		const hello = sent.find((c) => c.type === 'hello')
		reply(hello?.reqId as number, ['something.else'])
		await flush()
		expect(getNativeIdentityCapability()).toBe('missing')
		expect(getShellChatUiState()).toBe('chat_unavailable')
	})
})

describe('the call capability', () => {
	/** a fresh copy of the modules, so each case starts its own probe */
	function fresh() {
		let mod: { startCallCapabilityProbe: (inShell: boolean) => void; getCallCapabilityState: () => string } | undefined
		let route: { resetSharedHelloForTest: () => void } | undefined
		jest.isolateModules(() => {
			route = require('./nativeChatRouteRegister')
			mod = require('./callCapabilityRuntime')
		})
		route!.resetSharedHelloForTest()
		return mod!
	}
	it('10 s with no answer: old_shell is shown; a late valid hello with voiceCallV4 and a valid native version makes it compatible', async () => {
		const m = fresh()
		m.startCallCapabilityProbe(true)
		jest.advanceTimersByTime(10_500)
		await flush()
		expect(m.getCallCapabilityState()).toBe('old_shell')
		const hello = sent.find((c) => c.type === 'hello')
		reply(hello?.reqId as number, ['identity.native-keys.v1', 'voiceCallV4'])
		await flush()
		expect(m.getCallCapabilityState()).toBe('compatible')
	})
	it('a late valid hello WITHOUT voiceCallV4 stays old_shell (the rule is unchanged)', async () => {
		const m = fresh()
		m.startCallCapabilityProbe(true)
		jest.advanceTimersByTime(10_500)
		await flush()
		const hello = sent.find((c) => c.type === 'hello')
		reply(hello?.reqId as number, ['identity.native-keys.v1'])
		await flush()
		expect(m.getCallCapabilityState()).toBe('old_shell')
	})
	it('a late valid hello with voiceCallV4 but no valid native version stays old_shell', async () => {
		const m = fresh()
		m.startCallCapabilityProbe(true)
		jest.advanceTimersByTime(10_500)
		await flush()
		const hello = sent.find((c) => c.type === 'hello')
		reply(hello?.reqId as number, ['voiceCallV4'], false)
		await flush()
		expect(m.getCallCapabilityState()).toBe('old_shell')
	})
})
