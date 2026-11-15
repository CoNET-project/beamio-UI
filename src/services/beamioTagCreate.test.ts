/**
 * and (split): a browser key with the recovery phrase and no completed BeamioTag opens the Create Beamio ID
 * page directly. The page reuses the key and never creates a new wallet. A key-only record keeps the existing route. Decision tests here;
 * the EOA and key-hash invariant is in reuseKeepsKey.test.ts (jest loads beamio.ts through the test-only '@/' mapper).
 */
import { beamioTagCreateNeeded, recoverAllowed, recoverSourceOf } from './accountJudgement'

describe('route: key without BeamioTag goes to the Create Beamio ID page', () => {
	it('browser, existing key, no completed account: create page', () => {
		expect(beamioTagCreateNeeded({ shell: false, presence: 'has_account', completedAccount: false, hasMnemonic: true })).toBe(true)
	})
	it('browser, key only (no recovery phrase): not the create page; the existing route enters the app', () => {
		expect(beamioTagCreateNeeded({ shell: false, presence: 'has_account', completedAccount: false, hasMnemonic: false })).toBe(false)
	})
	it('browser, existing key, completed account: not this route (enter the app)', () => {
		expect(beamioTagCreateNeeded({ shell: false, presence: 'has_account', completedAccount: true, hasMnemonic: true })).toBe(false)
	})
	it('browser, no account: not this route (onboarding)', () => {
		expect(beamioTagCreateNeeded({ shell: false, presence: 'no_account', completedAccount: false, hasMnemonic: true })).toBe(false)
	})
	it('browser, undetermined: never the create page', () => {
		expect(beamioTagCreateNeeded({ shell: false, presence: 'undetermined', completedAccount: false, hasMnemonic: true })).toBe(false)
	})
	it('shell: keeps its own route (the native side holds the key)', () => {
		expect(beamioTagCreateNeeded({ shell: true, presence: 'has_account', completedAccount: false, hasMnemonic: true })).toBe(false)
	})
})

describe('page: reuse guard, no new wallet', () => {
	it('a confirmed local key is reused, also when the page requires reuse', () => {
		expect(recoverAllowed(recoverSourceOf({ status: 'loaded', keyPresent: true }), true)).toBe(true)
	})
	it('an empty store with the reuse requirement is refused (no new wallet)', () => {
		expect(recoverAllowed(recoverSourceOf({ status: 'empty', keyPresent: false }), true)).toBe(false)
	})
	it('an empty store without the requirement may create (the normal new account)', () => {
		expect(recoverAllowed(recoverSourceOf({ status: 'empty', keyPresent: false }), false)).toBe(true)
	})
	it('a locked, unreadable or unconfirmed store is refused in every case', () => {
		for (const status of ['locked', 'unavailable'] as const) {
			expect(recoverAllowed(recoverSourceOf({ status, keyPresent: false }), false)).toBe(false)
			expect(recoverAllowed(recoverSourceOf({ status, keyPresent: false }), true)).toBe(false)
		}
	})
	it('a loaded store without a key is refused (never replaced)', () => {
		expect(recoverAllowed(recoverSourceOf({ status: 'loaded', keyPresent: false }), false)).toBe(false)
	})
})
