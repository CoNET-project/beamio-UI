/**
 * @jest-environment node
 *
 * Entry coverage: every entry that opens the onboarding because no account was found goes through the one real native read
 * (confirmOnboarding / openOnboardingConfirmed) before goOnboarding. The entries that are not "no account" (the create-tag page for a key without a
 * BeamioTag, the recovery entry of an existing account) keep their own call. Source-order checks; the behaviour is in
 * AppEntryGate.startupTwoState.test.tsx (the start path and the platform rule).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('the entries that open the onboarding for "no account" are confirmed by one real native read', () => {
	it('the confirmation reads the pre-read again, never reuses an earlier answer, and branches walletStatus on every shell (not the user agent)', () => {
		const at = SRC.indexOf('const confirmNoMnemonicOnNative = async')
		expect(at).toBeGreaterThan(0)
		const body = SRC.slice(at, at + 4500)
		expect(body).toContain('queryNativeMnemonicPreread()')
		expect(body).toContain('validNativeApp(')
		expect(body).toContain('queryNativeWalletStatus()')
		// r11b: iOS no longer bare-proceeds after key_only-only check; same three-way as Android
		expect(body).not.toContain("if (platform === 'ios' && !prereadUnsupported)")
		expect(body).not.toContain("if (platform !== 'ios' || prereadUnsupported)")
		expect(body).toContain("ws.status !== 'no_key'")
		expect(SRC).not.toMatch(/navigator\.userAgent/)
	})

	it('the confirmation sends no native command from a page without a bridge, and an unsupported pre-read is confirmed by walletStatus (never an endless wait, never a bare proceed)', () => {
		const at = SRC.indexOf('const confirmNoMnemonicOnNative = async')
		const body = SRC.slice(at, at + 5500)
		const guard = body.indexOf("if (!isShellContext()) return 'proceed'")
		expect(guard).toBeGreaterThan(0)
		// the browser guard comes before the native pre-read
		expect(guard).toBeLessThan(body.indexOf('queryNativeMnemonicPreread()'))
		expect(body).toContain("const prereadUnsupported = real.kind === 'unknown' && real.reason === 'unsupported'")
		expect(body).toContain("if (real.kind !== 'absent' && !prereadUnsupported) {")
		// every shell (including iOS with a working pre-read) reads walletStatus after absent/unsupported
		expect(body).toContain('const ws = await queryNativeWalletStatus()')
		expect(body).toContain("notReadyReason === 'key_only'")
		// the other unknowns (not_ready, read_timeout, read_error) keep the wait
		expect(body).toContain("real.reason === 'read_timeout' ? 'native_read_timeout' : real.reason === 'not_ready' ? 'pre_read_not_ready' : 'record_unreadable'")
	})

	it('the four entries use openOnboardingConfirmed: chat capability resolved, walletEoaAddress no_key, storage read empty with native no_key, native no_key event', () => {
		for (const where of ["'chat capability resolved'", "'walletEoaAddress no_key'", "'storage read empty with native no_key'", "'native no_key event'"]) {
			expect(SRC).toContain(`openOnboardingConfirmed(${where})`)
		}
	})

	it('the start path confirms with the same function', () => {
		expect(SRC).toContain("if ((await confirmNoMnemonicOnNative(reqId)) === 'handled') return")
	})

	it('r11: page purge helpers are abolished; key_only enters local mode; browser key_only keeps the key', () => {
		expect(SRC).not.toContain('holdUnlessKeyOnlyPurged')
		expect(SRC).not.toContain('purgeKeyOnlyPageRecord')
		expect(SRC).toContain('enterKeyOnlyLocalMode')
		expect(SRC).toContain("notReadyReason === 'key_only'")
		expect(SRC).toContain("await openOnboardingConfirmed('start route onboard', {")
		expect(SRC).toContain("notifyShellEntry('browser_key_only_established')")
		expect(SRC).toContain('sendPwaEmptySignalIfExplicitEmpty')
	})

	it('r11: openOnboardingConfirmed emits pwaEmptySignal after confirmed empty (no purge hold); catch never fakes empty', () => {
		const o = SRC.slice(SRC.indexOf('const openOnboardingConfirmed = async'), SRC.indexOf('const openOnboardingConfirmed = async') + 2200)
		expect(o).toContain('sendPwaEmptySignalIfExplicitEmpty')
		expect(o).not.toContain('holdUnlessKeyOnlyPurged')
		expect(o).not.toContain('purgeKeyOnlyPageRecord')
		expect(o).not.toContain("sendPwaEmptySignalIfExplicitEmpty({ storageStatus: 'empty' })")
		expect(o).toContain('Untrusted failure: do not emit empty')
	})

	it('the only direct goOnboarding(false) calls are the helper itself and the sealed-copy check (pre-read plus walletStatus no_key)', () => {
		const direct: string[] = []
		let i = SRC.indexOf('goOnboarding(false)')
		while (i !== -1) {
			direct.push(SRC.slice(Math.max(0, i - 160), i).replace(/\s+/g, ' ').slice(-120))
			i = SRC.indexOf('goOnboarding(false)', i + 1)
		}
		// helper (also the start path), sealed-copy check
		expect(direct.length).toBe(2)
	})
})
