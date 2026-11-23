/**
 * G1 (option A): the native no_key signal reaches the controller before the shell's hello answer is known.
 * The gate must (a) route every no_key through the controller, which holds it back while the capability is unknown or blocked, and
 * (b) re-decide a held no_key when the hello answer arrives. A removed wiring fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const controller = readFileSync(join(__dirname, 'appEntryNoKeyController.ts'), 'utf8')

describe('G1: the import route waits for the shell capability', () => {
	it('the no_key watcher answers through the controller (no direct show)', () => {
		expect(gate).toContain('if (!noKeyCtl.onNativeNoKey()) return')
	})

	it('the hello answer re-decides a held no_key through the controller', () => {
		const hello = gate.indexOf('void ensureShellChatState().then((state) => {')
		expect(hello).toBeGreaterThan(-1)
		const block = gate.slice(hello, hello + 400)
		expect(block).toContain("noKeyCtl.capabilityResolved(state === 'native_chat')")
		// rule (b), spec r2.3 item 41: the held no_key now enters the onboarding (goOnboarding) instead of the retired import route (setNativeNoKey).
		// (R2271: the onboarding entries are confirmed by one real native read first: openOnboardingConfirmed, which ends in goOnboarding(false))
		expect(block).toContain("openOnboardingConfirmed('chat capability resolved')")
		expect(block.indexOf('capabilityResolved')).toBeLessThan(block.indexOf('openOnboardingConfirmed'))
		expect(gate).toContain('const openOnboardingConfirmed = async')
	})

	it('the controller holds a no_key while the capability is unknown and never shows it when blocked', () => {
		expect(controller).toContain("if (this.capability === 'blocked') return false")
		expect(controller).toContain("if (this.capability === 'unknown') {")
	})
})
