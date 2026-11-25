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

	it('the confirmation sends no native command from a page without a bridge, and an unsupported pre-read is confirmed by walletStatus (never an endless wait, never a bare proceed)', () => {
		const at = SRC.indexOf('const confirmNoMnemonicOnNative = async')
		const body = SRC.slice(at, at + 5500)
		const guard = body.indexOf("if (!isShellContext()) return 'proceed'")
		expect(guard).toBeGreaterThan(0)
		// the browser guard comes before the native pre-read
		expect(guard).toBeLessThan(body.indexOf('queryNativeMnemonicPreread()'))
		expect(body).toContain("const prereadUnsupported = real.kind === 'unknown' && real.reason === 'unsupported'")
		expect(body).toContain("if (real.kind !== 'absent' && !prereadUnsupported) {")
		// the unsupported answer is read through walletStatus whatever platform the shell declares
		expect(body).toContain("if (platform !== 'ios' || prereadUnsupported) {")
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

	it('0.53.52: the key-only purge is called from the one helper only, and the start path reaches the onboarding through that helper', () => {
		expect(SRC.match(/holdUnlessKeyOnlyPurged\(reqId\)/g)?.length).toBe(1) // the one call, in openOnboardingConfirmed
		expect(SRC).toContain('const holdUnlessKeyOnlyPurged = async')
		expect(SRC.match(/purgeKeyOnlyPageRecord\(\)/g)?.length).toBe(1)
		expect(SRC).toContain("await openOnboardingConfirmed('start route onboard', {")
		expect(SRC).toContain("await openOnboardingConfirmed('browser key-only page record'")
	})

	it('0.53.52: a process that read a valid mnemonic never purges, and every purge verdict other than deleted/absent/not_key_only holds the start', () => {
		const h = SRC.slice(SRC.indexOf('const holdUnlessKeyOnlyPurged = async'), SRC.indexOf('const openOnboardingConfirmed'))
		expect(h.indexOf('if (sessionSawValidRef.current) return true')).toBeGreaterThan(-1)
		expect(h.indexOf('if (sessionSawValidRef.current) return true')).toBeLessThan(h.indexOf('purgeKeyOnlyPageRecord()'))
		expect(h).toContain("purged.kind === 'unknown' || purged.kind === 'failed'")
		expect(h).toContain('return false')
		// the leftovers are cleared only for the wallet that was deleted
		expect(h).toContain('forgetPersistedShellEoa(purged.eoa)')
		expect(h).toContain('clearPendingCreateTag(purged.eoa)')
	})

	it('the only direct goOnboarding(false) calls are the helper itself (the start path goes through it too since 0.53.52, which is where the key-only purge is) and the sealed-copy check (pre-read plus walletStatus no_key)', () => {
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
