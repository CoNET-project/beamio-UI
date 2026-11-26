/**
 * @jest-environment node
 *
 * HC-LOCK in the gate (static): a native lock waits and retries; it never shows the storage-unavailable screen or onboards.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { nativeNoKeyRoute, nativeStartRoute } from '../services/accountJudgement'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('HC-LOCK in AppEntryGate', () => {
	it('native_locked branch waits and retries on a timer, before the shell background wait', () => {
		const at = gate.indexOf("if (reason === 'native_locked') {")
		const route = gate.indexOf('if (nativeShell && !SHELL_SCREEN_REASONS.has(reason)) {')
		expect(at).toBeGreaterThan(0)
		expect(at).toBeLessThan(route)
		expect(gate.slice(at, at + 400)).toContain('window.setTimeout(() => void init(), NATIVE_LOCKED_RETRY_MS)')
	})

	it('native_locked never shows the storage-unavailable screen or onboarding in that branch', () => {
		const at = gate.indexOf("if (reason === 'native_locked') {")
		const block = gate.slice(at, at + 400)
		expect(block).not.toContain('showStorageUnavailable')
		expect(block).not.toContain('enterOnboarding')
	})
})

// The walletEoaAddress local-home lock branch (L-EOA) was removed on purpose (the address-only local home must not be reachable).

describe('HC-LOCK pre-read locked in the gate (L-PRE)', () => {
	// Revised 2026-11-20 (rule, commit 2177455): a native lock with no PWA mnemonic is a retry with an unlock entry (nativeNoKeyRoute
	// and nativeStartRoute return native_locked), never onboarding and never the passcode page. The earlier 'unlock' expectation is superseded.
	it('a locked pre-read is native_locked (retry with the unlock entry), never onboarding, on the start route (rule 2026-11-20)', () => {
		expect(nativeNoKeyRoute({ kind: 'locked' })).toBe('native_locked')
		expect(nativeStartRoute({ pre: { kind: 'locked' }, walletState: 'not_reported', hasKey: 'not_reported', walletStatus: 'unknown' }).route).toBe('native_locked')
		const at = gate.indexOf('if (outcome.route === \'native_locked\') {')
		expect(at).toBeGreaterThan(0)
		const block = gate.slice(at, at + 200)
		expect(block).toContain("waitNativeLocked('pre-read locked')")
		expect(block).not.toContain('goOnboarding')
		expect(block).not.toContain("setVaultLockKind('native')")
	})
})

// Superseded by the 2026-11-20 rule: the 2026-11-18 'pre-read decides' rule (an absent pre-read onboards by itself) is replaced by
// nativeStartRoute: onboarding only on walletState absent with walletStatus no_key; a not_ready key_only status is status_not_no_key retry.
describe('key_only entry (2026-11-20 start route supersedes the 2026-11-18 pre-read rule)', () => {
	it('the ready event runs the init route (the start-up pre-read decides), with no onboarding or storage screen of its own', () => {
		const at = gate.indexOf('const onNativeWalletReady = () => { void initRef.current?.() }')
		expect(at).toBeGreaterThan(0)
		const line = gate.slice(at, gate.indexOf('\n', at))
		expect(line).toContain('void initRef.current?.()')
		expect(line).not.toContain('goOnboarding')
		expect(line).not.toContain('showStorageUnavailable')
	})

	it('with identity declared, the pre-read runs before any onboarding or wait: onboarding and the unknown wait come after it, and valid enters', () => {
		const pre = gate.indexOf('const lateAnswer = lateReadRef.current.lateAnswer')
		const onboard = gate.indexOf("if (outcome.route === 'onboard') {")
		const unknownWait = gate.indexOf('startupWait(`native start: ${outcome.reason}`')
		expect(pre).toBeGreaterThan(0)
		expect(onboard).toBeGreaterThan(pre)
		expect(unknownWait).toBeGreaterThan(pre)
		expect(gate.indexOf("if (pre.kind === 'valid') {")).toBeLessThan(onboard)
	})

	it('nativeStartRoute (r11b): not_ready without key_only → retry; key_only → local; no_key + absent → onboard; unknown pre → retry; gate onboard branch never deletes', () => {
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'not_ready' })).toEqual({
			route: 'retry',
			reason: 'status_not_no_key',
		})
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'not_ready', notReadyReason: 'key_only' })).toEqual({
			route: 'local',
			reason: 'key_only',
		})
		const at = gate.indexOf("if (outcome.route === 'onboard') {")
		expect(at).toBeGreaterThan(0)
		expect(gate.slice(at, gate.indexOf('\n\t\t\t}\n', at))).not.toMatch(/remove|delete|clear|reset|wipe|cleanup/i)
		expect(gate).toContain("if (outcome.route === 'local')")
		expect(gate).toContain('enterKeyOnlyLocalMode')
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' }).route).toBe('onboard')
		expect(nativeStartRoute({ pre: { kind: 'unknown' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' }).route).toBe('retry')
	})
})
