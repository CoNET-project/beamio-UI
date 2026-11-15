/**
 * The shell bridge accepts messages only from the explicit shell origins. The page's own origin is never
 * the base of the check. `null`, an empty origin, and any look-alike origin are refused.
 */
import fs from 'fs'
import path from 'path'
import { isExplicitShellOrigin, isTrustedBridgeSource, isTrustedShellSource, SHELL_ORIGINS } from './bridgeSource'

const IOS = 'cashtrees-local://localhost'
const ANDROID = 'https://appassets.androidplatform.net'
const mainFrame = (origin: string) => ({ isMainFrame: true, origin })

describe('the explicit shell origin allowlist', () => {
	it('lists exactly the two real shell origins', () => {
		expect([...SHELL_ORIGINS]).toEqual([IOS, ANDROID])
	})

	it.each([
		['null', 'null'],
		['empty', ''],
		['about:blank', 'about:blank'],
		['file scheme', 'file://'],
		['the placeholder of the fixture', 'https://shell.test.invalid'],
		['a suffix on the Android origin', 'https://appassets.androidplatform.net.evil.example'],
		['a trailing slash on the Android origin', 'https://appassets.androidplatform.net/'],
		['a suffix on the iOS origin', 'cashtrees-local://localhost.evil'],
		['the web origin of a browser', 'http://localhost'],
		['another site', 'https://beamio.ca'],
	])('refuses a message from %s', (_label, origin) => {
		expect(isTrustedShellSource(mainFrame(origin))).toBe(false)
		expect(isExplicitShellOrigin(origin)).toBe(false)
	})

	it('accepts a message from the main frame of the iOS origin and of the Android origin', () => {
		expect(isTrustedShellSource(mainFrame(IOS))).toBe(true)
		expect(isTrustedShellSource(mainFrame(ANDROID))).toBe(true)
	})

	it('refuses a real origin that comes from a child frame', () => {
		expect(isTrustedShellSource({ isMainFrame: false, origin: IOS })).toBe(false)
		expect(isTrustedShellSource({ isMainFrame: false, origin: ANDROID })).toBe(false)
	})
})

describe('the exact-match check of one expected origin', () => {
	it('never matches an empty or opaque expected origin', () => {
		expect(isTrustedBridgeSource(mainFrame('null'), 'null')).toBe(false)
		expect(isTrustedBridgeSource(mainFrame(''), '')).toBe(false)
	})

	it('matches exactly, with no trailing slash allowed', () => {
		expect(isTrustedBridgeSource(mainFrame(ANDROID), ANDROID)).toBe(true)
		expect(isTrustedBridgeSource(mainFrame(ANDROID + '/'), ANDROID)).toBe(false)
	})
})

describe('the shell bridge listener uses the allowlist, not the page origin', () => {
	const bridge = fs.readFileSync(path.join(__dirname, 'webview-bridge.ts'), 'utf8')

	it('checks each inbound message against the allowlist', () => {
		expect(bridge).toContain('if (!isTrustedShellSource(bridgeSourceOf(e, window))) return;')
		expect(bridge).not.toContain('window.location.origin')
		expect(bridge).not.toContain('SHELL_ORIGIN')
	})
})
