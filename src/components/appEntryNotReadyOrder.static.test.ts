/**
 * @jest-environment node
 *
 * Ordering check (2026-11-21): every goOnboarding call in AppEntryGate is either after the shell guard in the start, or sits in a
 * branch that is already gated by an explicit native no_key (the source-order check; the behaviour is in shellNotReadyWait.test.ts).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const GUARD = SRC.indexOf('shellNotReadyWaitReason({ isShell: isShellContext(), walletStatus: shellWalletStatus, presence })')
// The explicit no_key gates that may precede the guard: the native no_key answer, the no_key route, or the no_key watcher.
const EXPLICIT_NO_KEY = /NO_KEY_ERROR|no_key|onNativeNoKey|noKeyCtl|installNativeNoKeyWatcher|nativeStartRoute|route === 'onboard'/

function callSites(): number[] {
	const out: number[] = []
	let i = SRC.indexOf('goOnboarding(')
	while (i !== -1) {
		// skip the declaration itself
		if (!SRC.slice(Math.max(0, i - 20), i).includes('const ')) out.push(i)
		i = SRC.indexOf('goOnboarding(', i + 1)
	}
	return out
}

describe('goOnboarding call sites in AppEntryGate', () => {
	test('the guard exists', () => {
		expect(GUARD).toBeGreaterThan(-1)
	})

	test('every call site is after the guard, or is in an explicit no_key gate', () => {
		const sites = callSites()
		// (four of the old direct calls now go through openOnboardingConfirmed, so there are fewer direct sites)
		expect(sites.length).toBeGreaterThanOrEqual(5)
		for (const at of sites) {
			if (at > GUARD) continue
			const before = SRC.slice(Math.max(0, at - 900), at)
			expect(before).toMatch(EXPLICIT_NO_KEY)
		}
	})

	test('no call site before the guard is reached on a bare walletStatus other than no_key', () => {
		expect(SRC).not.toContain('iosNotReadyOnboardingEntry')
		expect(SRC).not.toContain('iosSilentOnboarding')
		expect(SRC).not.toContain('iosNotReadyOnboardingRef')
	})
})
