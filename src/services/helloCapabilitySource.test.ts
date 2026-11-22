/**
 * @jest-environment node
 *
 * The capabilities are read from the hello ack only (ack.result.capabilities). The init 'ready' event carries a shorter list that omits
 * identity.native-keys.v1 (iOS BeamioConetChatModule.swift:1246), so a 'ready' payload is never the capability answer.
 * SYNTHETIC values only.
 */
// a real event target for window (the native channel is a window event), with the iOS bridge object on it
const target = new EventTarget()
const w = globalThis as unknown as Record<string, unknown>
if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !== 'function') {
	;(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class extends Event {
		detail: unknown
		constructor(type: string, init?: { detail?: unknown }) {
			super(type)
			this.detail = init?.detail
		}
	}
}
w.window = Object.assign(target, { location: { origin: 'http://localhost' } })
const win = w.window as unknown as Record<string, unknown>
const NATIVE_KEYS = 'identity.native-keys.v1'

function answerHelloWith(type: 'ack' | 'ready', caps: string[]): void {
	win.CashTreesIOS = {
		chatModuleCommand: (p: { command: { type: string; reqId: number } }) => {
			if (p.command.type !== 'hello') return
			const event = type === 'ack'
				? { type: 'ack', reqId: p.command.reqId, ok: true, result: { capabilities: caps } }
				: { type: 'ready', reqId: p.command.reqId, result: { capabilities: caps } }
			setTimeout(() => target.dispatchEvent(new (globalThis as unknown as { CustomEvent: new (t: string, i: unknown) => Event }).CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })), 0)
		},
	}
}

describe('the capability answer is the hello ack, never the init ready event', () => {
	it('a hello ack declaring the native keys is read as declared', async () => {
		answerHelloWith('ack', [NATIVE_KEYS, 'x'])
		const { probeNativeCapabilities } = require('./nativeChatRouteRegister')
		await expect(probeNativeCapabilities(2000)).resolves.toEqual({ answered: true, capabilities: [NATIVE_KEYS, 'x'] })
	})
	it('a ready event with a list that omits the native keys is not an answer: nothing is declared', async () => {
		answerHelloWith('ready', ['only-this'])
		const { probeNativeCapabilities } = require('./nativeChatRouteRegister')
		const got = await probeNativeCapabilities(2000)
		expect(got.capabilities).not.toContain(NATIVE_KEYS)
		expect(got.answered).toBe(false)
	})
	it('an ack without result declares nothing: the top-level capabilities are never read', async () => {
		win.CashTreesIOS = {
			chatModuleCommand: (p: { command: { type: string; reqId: number } }) => {
				if (p.command.type !== 'hello') return
				const event = { type: 'ack', reqId: p.command.reqId, ok: true, capabilities: [NATIVE_KEYS, 'x'] }
				setTimeout(() => target.dispatchEvent(new (globalThis as unknown as { CustomEvent: new (t: string, i: unknown) => Event }).CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event } })), 0)
			},
		}
		const { probeNativeCapabilities } = require('./nativeChatRouteRegister')
		await expect(probeNativeCapabilities(2000)).resolves.toEqual({ answered: true, capabilities: [] })
	})
})
