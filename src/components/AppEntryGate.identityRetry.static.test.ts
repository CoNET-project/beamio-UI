/**
 * The gate's identity retry wiring: the probe cadence (10 s, 30 s, then 60 s), the manual retry, the unanswered start on the
 * local home with a public address, and the retry screen without one. Reads the sources; the cadence is tested in
 * nativeIdentityProbeRetry.test.ts.
 */
import fs from 'fs'
import path from 'path'

const gate = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const notice = fs.readFileSync(path.join(__dirname, 'ShellChatUnavailableNotice.tsx'), 'utf8')

describe('AppEntryGate: the unanswered hello is probed on the cadence and retried by hand', () => {
	it('the probe waits on the shared delay, with no fixed 10 s retry screen timer', () => {
		expect(gate).toContain('identityProbeDelayMs(identityProbesDoneRef.current)')
		expect(gate).not.toContain('}, 10_000)')
	})

	it('the start records the state and restarts the cadence; a declared answer enters the account again', () => {
		expect(gate).toContain('setNativeIdentityCapability(identity)')
		expect(gate).toContain("if (cap === 'declared') {")
		expect(gate).toContain('void initRef.current?.()')
	})

	it('the retry screen button requests a probe, and does not clear the screen by itself', () => {
		expect(gate).not.toContain('onClick={() => requestNativeIdentityRetry()}')  // 0.53.44: retired startup control (two-landing rule); must be absent
	})

	// Rewritten for the current rule (spec item 42(5)): an unanswered hello never routes. A valid page mnemonic is the one route.
	it('an unanswered hello never opens the home by itself: only a valid page mnemonic does (applyLocalWallet(first.eoa))', () => {
		expect(gate).toContain('applyLocalWallet(first.eoa)')
		expect(gate).not.toContain('applyLocalWallet(persisted)')
	})
})

describe('ShellChatUnavailableNotice: the retry hint on the identity entries', () => {
	it('the hint reads from the locale key and the retry action requests a probe', () => {
		expect(notice).toContain("tu(missing ? 'shell_chat_unavailable_body' : windowOpen ? 'native_preparing_wallet' : 'native_not_ready_hint')")
		expect(notice).toContain('onClick={() => requestNativeIdentityRetry()}')
	})
})
