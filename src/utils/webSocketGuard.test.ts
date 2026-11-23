/**
 * Negative probe for the WebSocket refusal (project rule). The probe never opens a real connection:
 * every attempt goes through the refused global constructor, which throws before any socket exists.
 */
import { WEBSOCKET_REFUSAL, webSocketConstructorIsRefused, webSocketRefusedCount } from './webSocketGuard'

describe('WebSocket refusal', () => {
	it('replaces the global constructor before any caller uses it', () => {
		expect(webSocketConstructorIsRefused()).toBe(true)
	})

	it('refuses a ws:// and a wss:// construction before it connects', () => {
		const before = webSocketRefusedCount()
		expect(() => new (globalThis as any).WebSocket('ws://127.0.0.1:9/probe')).toThrow(WEBSOCKET_REFUSAL)
		expect(() => new (globalThis as any).WebSocket('wss://127.0.0.1:9/probe')).toThrow(WEBSOCKET_REFUSAL)
		expect(webSocketRefusedCount()).toBe(before + 2)
	})

	it('cannot be replaced by an ordinary assignment', () => {
		const scope = globalThis as any
		const original = scope.WebSocket
		try {
			scope.WebSocket = function Other() {}
		} catch {
			/* a strict-mode assignment may throw; the value must still be the refusal */
		}
		expect(scope.WebSocket).toBe(original)
		expect(webSocketConstructorIsRefused()).toBe(true)
	})
})
