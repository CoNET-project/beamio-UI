/**
 * R88 review: in a shell, the final onboarding entry needs an explicit walletStatus no_key. A not_ready or unknown native answer
 * with an empty page is unknown (startup wait). Static pin of the guard text and its order; the walletState-absent path is answered
 * earlier (option A notice), so the guard is defence in depth. Device repro is pending.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('shell onboarding requires an explicit walletStatus no_key (R88)', () => {
	it('the trusted-empty onboarding is guarded by a shell check on shellWalletStatus no_key, before goOnboarding', () => {
		// the guard is written as isExplicitNativeNoKey(shellWalletStatus) (same rule: only an explicit no_key passes)
		const guard = src.indexOf('if (isShellContext() && !isExplicitNativeNoKey(shellWalletStatus)) {')
		const entry = src.indexOf('// Trusted empty (or empty status): Create Beamio ID / onboarding.')
		expect(guard).toBeGreaterThan(0)
		expect(entry).toBeGreaterThan(guard)
		const between = src.slice(guard, entry)
		expect(between).toContain("startupWait(`shell onboarding needs an explicit walletStatus no_key")
		expect(between).toContain('return')
	})

	it('the guard is not weakened to unknown-as-no-key: no shell onboarding without the no_key check in that block', () => {
		const block = src.slice(src.indexOf('if (isShellContext() && !isExplicitNativeNoKey(shellWalletStatus)) {'), src.indexOf('// Trusted empty (or empty status): Create Beamio ID / onboarding.'))
		expect(block).not.toContain('goOnboarding')
	})
})
