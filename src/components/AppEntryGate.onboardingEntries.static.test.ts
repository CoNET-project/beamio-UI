/**
 * @jest-environment node
 *
 * R2271 (entry coverage): every entry that opens the onboarding because no account was found goes through the one real native read
 * (confirmOnboarding / openOnboardingConfirmed) before goOnboarding. The entries that are not "no account" (the create-tag page for a key without a
 * BeamioTag, the recovery entry of an existing account) keep their own call. Source-order checks; the behaviour is in
 * AppEntryGate.startupTwoState.test.tsx (the start path and the platform rule).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('the entries that open the onboarding for "no account" are confirmed by one real native read', () => {
	it('the confirmation reads the pre-read again, never reuses an earlier answer, and decides by the shell-declared platform (not the user agent)', () => {
		const at = SRC.indexOf('const confirmNoMnemonicOnNative = async')
		expect(at).toBeGreaterThan(0)
		const body = SRC.slice(at, at + 4500)
		expect(body).toContain('queryNativeMnemonicPreread()')
		expect(body).toContain('validNativeApp(')
		expect(body).toContain("platform !== 'ios'")
		expect(body).toContain('queryNativeWalletStatus()')
		expect(SRC).not.toMatch(/navigator\.userAgent/)
	})

	it('the four entries use openOnboardingConfirmed: chat capability resolved, walletEoaAddress no_key, storage read empty with native no_key, native no_key event', () => {
		for (const where of ["'chat capability resolved'", "'walletEoaAddress no_key'", "'storage read empty with native no_key'", "'native no_key event'"]) {
			expect(SRC).toContain(`openOnboardingConfirmed(${where})`)
		}
	})

	it('the start path confirms with the same function', () => {
		expect(SRC).toContain("if ((await confirmNoMnemonicOnNative(reqId)) === 'handled') return")
	})

	it('the only direct goOnboarding(false) calls are the helper itself, the start path after its confirmation, and the sealed-copy check (pre-read plus walletStatus no_key)', () => {
		const direct: string[] = []
		let i = SRC.indexOf('goOnboarding(false)')
		while (i !== -1) {
			direct.push(SRC.slice(Math.max(0, i - 160), i).replace(/\s+/g, ' ').slice(-120))
			i = SRC.indexOf('goOnboarding(false)', i + 1)
		}
		// helper, start path, sealed-copy check
		expect(direct.length).toBe(3)
	})
})
