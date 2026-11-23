/**
 * R81 item 8: the runtime WebSocket refusal probe. The guard is installed by importing it (as the entry does); the probe asks the global
 * constructor to refuse a URL-less construction and never opens a connection. SYNTHETIC: no network.
 */
import { probeWebSocketRefusal, webSocketConstructorIsRefused, WEBSOCKET_REFUSAL, webSocketRefusedCount } from './webSocketGuard'

describe('WebSocket runtime refusal probe (R81 item 8)', () => {
	it('with the project guard installed, the probe answers refused, and the global is the refusal', () => {
		expect(webSocketConstructorIsRefused()).toBe(true)
		expect(probeWebSocketRefusal()).toBe('refused')
	})

	it('a construction of the global with a URL is refused by the same refusal (no connection is attempted)', () => {
		const before = webSocketRefusedCount()
		expect(() => new (globalThis as unknown as { WebSocket: new (u: string) => object }).WebSocket('ws://127.0.0.1:9')).toThrow(WEBSOCKET_REFUSAL)
		expect(webSocketRefusedCount()).toBeGreaterThan(before)
	})
})
