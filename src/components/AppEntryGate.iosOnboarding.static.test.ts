/**
 * / 1428 / item 2: an unreadable native answer is the startup wait on every shell, never a direct onboarding.
 * The function this file used to read (iosNotReadyOnboardingEntry) was removed by that rule; the behaviour is pinned through the start
 * route itself (nativeStartRoute, behaviour) and through the gate's retry branch (static).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { nativeStartRoute } from '../services/accountJudgement'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('an unreadable or unknown native answer is never a direct onboarding', () => {
	it('unknown wallet state and an unreadable key marker: retry (the startup wait), not onboard', () => {
		const out = nativeStartRoute({ pre: { kind: 'unknown', reason: 'x' }, walletState: 'unknown', hasKey: 'unknown', walletStatus: 'unknown' })
		expect(out.route).toBe('retry')
	})
	it('unknown wallet state with a no_key status: still retry, never onboard', () => {
		const out = nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'unknown', hasKey: false, walletStatus: 'no_key' })
		expect(out.route).toBe('retry')
	})
	it('positive control: a confirmed absent record with no_key onboards', () => {
		const out = nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' })
		expect(out.route).toBe('onboard')
	})
	it('the gate retry branch starts the startup wait and never calls the onboarding directly', () => {
		const at = gate.indexOf("if (outcome.route === 'retry') {")
		expect(at).toBeGreaterThan(0)
		const branch = gate.slice(at, at + 400)
		expect(branch).toContain('startupWait(')
		expect(branch).not.toContain('goOnboarding(')
	})
	it('no-key onboarding does not treat a device hint as an account (identity must be declared)', () => {
		const guard = gate.slice(gate.indexOf('const enterOnboardingIfNoKeyConfirmed'), gate.indexOf('const enterOnboardingIfNoKeyConfirmed') + 700)
		expect(guard).not.toContain('readPersistedShellEoa() || identityState')
		expect(guard).toContain("if (identityState !== 'declared') return false")
	})
})
