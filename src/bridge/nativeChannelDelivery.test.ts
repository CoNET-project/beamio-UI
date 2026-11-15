/**
 * Native delivery to the page. The shell delivers its events as `CustomEvent`s on `window` (`cashtreesios` on iOS,
 * `cashtreesandroid` on Android). A `CustomEvent` has no `origin`, so the origin allowlist applies only to the
 * window `message` path (`postMessage`). These tests keep both paths working: a native event reaches its listener,
 * and the window message gate still refuses an empty or opaque origin. SYNTHETIC values only.
 */
import { onInAppBrowserClosed } from '../utils/cashTreesNativeNfc'
import './webview-bridge'

const IOS_ORIGIN = 'cashtrees-local://localhost'
const BRIDGE_LOG = 'NativeToJavaScript Bridge got event'

describe('native CustomEvent delivery is not gated by origin', () => {
	it.each(['cashtreesios', 'cashtreesandroid'])('a %s event reaches its listener with its detail intact', (channel) => {
		const handler = jest.fn()
		const off = onInAppBrowserClosed(handler)
		const event = new CustomEvent(channel, {
			detail: { action: 'inAppBrowserClosed', ok: true, requestId: 'synthetic-request-1', url: 'https://example.invalid/' },
		})
		// A CustomEvent carries no origin, and the page must not require one on this path.
		expect('origin' in event).toBe(false)
		window.dispatchEvent(event)
		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler.mock.calls[0][0]).toMatchObject({ action: 'inAppBrowserClosed', ok: true, requestId: 'synthetic-request-1' })
		off()
	})

	it('a CustomEvent does not go through the window message gate', () => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		try {
			window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'inAppBrowserClosed' } }))
			expect(log.mock.calls.some((args) => String(args[0]).startsWith(BRIDGE_LOG))).toBe(false)
		} finally {
			log.mockRestore()
		}
	})
})

describe('the window message gate still applies to postMessage', () => {
	it('accepts a main-frame message from the iOS shell origin', () => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		try {
			window.dispatchEvent(
				new MessageEvent('message', { data: JSON.stringify({ event: 'synthetic' }), origin: IOS_ORIGIN, source: window }),
			)
			expect(log.mock.calls.some((args) => String(args[0]).startsWith(BRIDGE_LOG))).toBe(true)
		} finally {
			log.mockRestore()
		}
	})

	it.each([
		['an empty origin', ''],
		['an opaque origin', 'null'],
		['a look-alike origin', 'cashtrees-local://localhost.evil'],
	])('refuses a message with %s', (_label, origin) => {
		const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		try {
			window.dispatchEvent(
				new MessageEvent('message', { data: JSON.stringify({ event: 'synthetic' }), origin, source: window }),
			)
			expect(log.mock.calls.some((args) => String(args[0]).startsWith(BRIDGE_LOG))).toBe(false)
		} finally {
			log.mockRestore()
		}
	})
})
