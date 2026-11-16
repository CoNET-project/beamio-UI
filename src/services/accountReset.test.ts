/**
 * Y.85 account-reset state machine, vectors ST-01 to ST-08 (accountResetCases in pgp-migration-vectors.v2.json, sha256 7aeb7537…).
 * The vector values present / absent / unknown map to has / confirmed_none / unknown (Y.89). SYNTHETIC values only.
 */
import { decideAccountReset, idbPresenceOf, nativePresenceOfState, type AccountResetInput, type NativePresence } from './accountPresence'

type Side = 'present' | 'absent' | 'unknown'
const side = (v: Side): NativePresence => (v === 'present' ? 'has' : v === 'absent' ? 'confirmed_none' : 'unknown')

const cases: Array<{ id: string; input: { idb: Side; native: Side; locked?: boolean; userConfirmedRecovery: boolean; newAccountEstablished: boolean }; expect: 'onboarding' | 'continue_account' | 'retry_unknown' | 'cleanup_old' }> = [
	{ id: 'ST-01', input: { idb: 'absent', native: 'absent', userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'onboarding' },
	{ id: 'ST-02', input: { idb: 'present', native: 'absent', userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'continue_account' },
	{ id: 'ST-03', input: { idb: 'absent', native: 'present', userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'continue_account' },
	{ id: 'ST-04', input: { idb: 'unknown', native: 'absent', userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'retry_unknown' },
	{ id: 'ST-05', input: { idb: 'present', native: 'present', userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'continue_account' },
	{ id: 'ST-06', input: { idb: 'absent', native: 'absent', userConfirmedRecovery: false, newAccountEstablished: true }, expect: 'onboarding' },
	{ id: 'ST-07', input: { idb: 'absent', native: 'absent', userConfirmedRecovery: true, newAccountEstablished: true }, expect: 'cleanup_old' },
	{ id: 'ST-08', input: { idb: 'absent', native: 'unknown', locked: true, userConfirmedRecovery: false, newAccountEstablished: false }, expect: 'retry_unknown' },
]

describe('Y.85 account reset (ST-01 to ST-08)', () => {
	for (const c of cases) {
		it(`${c.id}: ${c.expect}`, () => {
			const input: AccountResetInput = {
				idb: side(c.input.idb),
				native: side(c.input.native),
				locked: c.input.locked,
				userConfirmedRecovery: c.input.userConfirmedRecovery,
				newAccountEstablished: c.input.newAccountEstablished,
			}
			expect(decideAccountReset(input)).toBe(c.expect)
		})
	}

	it('onboarding never deletes: no decision is cleanup_old without the confirmed recovery', () => {
		expect(decideAccountReset({ idb: 'confirmed_none', native: 'confirmed_none', userConfirmedRecovery: false, newAccountEstablished: true })).toBe('onboarding')
	})

	it('a timeout is retry_unknown even when the other side is confirmed none', () => {
		expect(decideAccountReset({ idb: 'confirmed_none', native: 'confirmed_none', timeout: true, userConfirmedRecovery: false, newAccountEstablished: false })).toBe('retry_unknown')
	})
})

describe('IndexedDB side (Y.85 input idb)', () => {
	it('a key is present, an empty store is confirmed none, the rest is unknown', () => {
		expect(idbPresenceOf('key')).toBe('has')
		expect(idbPresenceOf('absent')).toBe('confirmed_none')
		for (const s of ['account_without_key', 'corrupt', 'unavailable', 'unfinished', 'locked'] as const) {
			expect(idbPresenceOf(s)).toBe('unknown')
		}
	})
})

describe('native side (Y.89 with Y.90 kPresent)', () => {
	it('no_key with kPresent false is confirmed none; true or absent is unknown', () => {
		expect(nativePresenceOfState({ status: 'no_key' }, false)).toBe('confirmed_none')
		expect(nativePresenceOfState({ status: 'no_key' }, true)).toBe('unknown')
		expect(nativePresenceOfState({ status: 'no_key' }, undefined)).toBe('unknown')
	})

	it('locked or unlocked is has; g1 is has; unreadable or no reason is unknown; unknown snapshot is unknown', () => {
		expect(nativePresenceOfState({ status: 'unlocked', eoa: '0x1111111111111111111111111111111111111111' }, undefined)).toBe('has')
		expect(nativePresenceOfState({ status: 'locked', eoa: '0x1111111111111111111111111111111111111111' }, undefined)).toBe('has')
		expect(nativePresenceOfState({ status: 'not_ready', notReadyReason: 'g1_uninitialized' }, undefined)).toBe('has')
		expect(nativePresenceOfState({ status: 'not_ready', notReadyReason: 'unreadable' }, undefined)).toBe('unknown')
		expect(nativePresenceOfState({ status: 'not_ready' }, undefined)).toBe('unknown')
		expect(nativePresenceOfState({ status: 'unknown' }, false)).toBe('unknown')
	})
})

/**
 * Y.93 2 capability tiers (onboardingCompatCases CP-03 to CP-06, pgp-migration-vectors.v2.json sha256 6d5b3129…).
 */
import { shellTierOf } from './accountPresence'

describe('Y.93 capability tiers (CP-03 to CP-06)', () => {
	it('CP-03: a browser (no native side) is the browser tier: IndexedDB only, an empty store may onboard', () => {
		expect(shellTierOf({ shell: false, nativeKeys: false, kpresent: false })).toBe('browser')
	})

	it('CP-04: a shell without identity.native-keys.v1 is the legacy tier: a missing capability (option A), never onboarding', () => {
		expect(shellTierOf({ shell: true, nativeKeys: false, kpresent: false })).toBe('legacy_shell')
	})

	it('CP-05: native-keys reported without kpresent is native_no_kpresent: the native side is unknown', () => {
		expect(shellTierOf({ shell: true, nativeKeys: true, kpresent: false })).toBe('native_no_kpresent')
	})

	it('CP-06: both reported is native_full: the two-sided Y.89 and Y.85 judgement', () => {
		expect(shellTierOf({ shell: true, nativeKeys: true, kpresent: true })).toBe('native_full')
	})
})
