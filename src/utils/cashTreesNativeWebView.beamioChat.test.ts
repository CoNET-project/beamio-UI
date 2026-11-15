/**
 * (JS SDK check, three environments): a shell that has only `window.BeamioChat`is a native WebView for the entry
 * gate, the same as the chat layer already treats it. Before this, such a page took the browser onboarding path (harness
 * android-beamioonly, 2026-11-14). SYNTHETIC objects only.
 */
import { isCashTreesNativeWebView } from './cashTreesNativeNfc'

const w = window as unknown as {
	BeamioChat?: unknown
	BeamioShell?: unknown
	CashTreesAndroid?: unknown
	CashTreesIOS?: unknown
}

afterEach(() => {
	delete w.BeamioChat
	delete w.BeamioShell
	delete w.CashTreesAndroid
	delete w.CashTreesIOS
})

describe('isCashTreesNativeWebView (the entry gate) with the Android chat channel', () => {
	it('a plain browser page is not a native WebView', () => {
		expect(isCashTreesNativeWebView()).toBe(false)
	})

	it('window.BeamioChat alone makes the page a native WebView (the chat layer already does)', () => {
		w.BeamioChat = { postMessage: () => undefined, onmessage: null }
		expect(isCashTreesNativeWebView()).toBe(true)
	})

	it('a BeamioChat that is not an object does not count', () => {
		w.BeamioChat = 'synthetic'
		expect(isCashTreesNativeWebView()).toBe(false)
	})

	it('the legacy CashTreesAndroid bridge with a known method is still a native WebView', () => {
		w.CashTreesAndroid = { debugLog: () => undefined }
		expect(isCashTreesNativeWebView()).toBe(true)
	})

	it('the iOS shell is still a native WebView', () => {
		w.CashTreesIOS = {}
		expect(isCashTreesNativeWebView()).toBe(true)
	})
})
