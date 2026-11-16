/**
 * walletEoaAddress answers `no_key` (the native layer holds no key). The three combinations that decide the page:
 *  1. no page copy, walletStatus no_key and kPresent false  -> onboarding
 *  2. a page copy present (any native facts)                -> native_key_missing (recovery only, never a retry loop)
 *  3. no copy, and the facts do not confirm the absence      -> retry (kPresent true, undefined, another status, or no facts)
 */
import { decideNoKeyEntry, type NoKeyFacts } from './noKeyEntry'

const noKeyAbsent: NoKeyFacts = { walletStatus: 'no_key', kPresent: false }

describe('decideNoKeyEntry: combination 1, no page copy and confirmed absence', () => {
	it('onboards when walletStatus is no_key and kPresent is false', () => {
		expect(decideNoKeyEntry(noKeyAbsent, 'empty')).toBe('onboarding')
	})
})

describe('decideNoKeyEntry: combination 2, a page copy is present', () => {
	it('is native_key_missing for every native fact, so recovery is shown instead of a retry', () => {
		expect(decideNoKeyEntry(noKeyAbsent, 'present')).toBe('native_key_missing')
		expect(decideNoKeyEntry({ walletStatus: 'no_key', kPresent: true }, 'present')).toBe('native_key_missing')
		expect(decideNoKeyEntry(null, 'present')).toBe('native_key_missing')
	})
})

describe('decideNoKeyEntry: combination 3, no copy and the absence is not confirmed', () => {
	it('retries when kPresent is true (the native layer says the key is there)', () => {
		expect(decideNoKeyEntry({ walletStatus: 'no_key', kPresent: true }, 'empty')).toBe('retry')
	})
	it('retries when kPresent is not reported (identity.kpresent.v1 not declared)', () => {
		expect(decideNoKeyEntry({ walletStatus: 'no_key', kPresent: undefined }, 'empty')).toBe('retry')
	})
	it('retries when walletStatus is not no_key', () => {
		expect(decideNoKeyEntry({ walletStatus: 'locked', kPresent: undefined }, 'empty')).toBe('retry')
		expect(decideNoKeyEntry({ walletStatus: 'unavailable', kPresent: false }, 'empty')).toBe('retry')
	})
	it('retries when the native facts could not be read', () => {
		expect(decideNoKeyEntry(null, 'empty')).toBe('retry')
	})
	it('retries when the page record could not be read', () => {
		expect(decideNoKeyEntry(noKeyAbsent, 'unknown')).toBe('retry')
	})
})
