/**
 * Owner decision (2026-11-16, unified across PWA, iOS and Android): with no mnemonic on either side the app enters onboarding directly; a
 * unknown, locked, not-ready or unreadable answer is a retry, never onboarding, however many retries were used; PGP alone never decides an
 * account; the cleanup of previous storage happens only after a confirmed recovery. SYNTHETIC values only.
 */
import { decideAccountReset, idbPresenceOf, nativePresence, type NativePresence } from './accountPresence'
import { idbSignalOf } from './accountJudgement'

const base = { userConfirmedRecovery: false, newAccountEstablished: false }

describe('no mnemonic on either side: direct onboarding, no intermediate screen', () => {
	it('IDB confirmed none and native confirmed none: onboarding (nothing is deleted)', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native: 'confirmed_none' })).toBe('onboarding')
	})

	it('a browser with no native side: IDB confirmed none is onboarding', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native: 'confirmed_none' })).toBe('onboarding')
	})

	it('native no_key with kPresent false is a confirmed none (no key on the native side)', () => {
		const native = nativePresence({ ws: 'no_key', kPresent: false, snapshotUnknown: false })
		expect(native).toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native })).toBe('onboarding')
	})

	it('onboarding is not a cleanup: a confirmed none without a confirmed recovery never cleans', () => {
		expect(decideAccountReset({ ...base, idb: 'confirmed_none', native: 'confirmed_none', newAccountEstablished: true })).toBe('onboarding')
	})
})

describe('a mnemonic on one side: the account continues on that side', () => {
	it('only IDB has the key: continue', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('key'), native: 'confirmed_none' })).toBe('continue_account')
	})

	it('only the native side has the key: continue', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native: 'has' })).toBe('continue_account')
	})

	it('a not_ready G1 wallet on the native side is present: continue', () => {
		const native = nativePresence({ ws: 'not_ready', reason: 'g1_uninitialized', snapshotUnknown: false })
		expect(native).toBe('has')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native })).toBe('continue_account')
	})
})

describe('unknown, locked, not ready, unreadable and timeout: retry, never onboarding', () => {
	it('an unreadable IDB with a confirmed none native side is a retry, not onboarding', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('read_error' as never), native: 'confirmed_none' })).toBe('retry_unknown')
	})

	it('an unreadable native record with an absent IDB is a retry, not onboarding', () => {
		const native = nativePresence({ ws: 'not_ready', reason: 'unreadable', snapshotUnknown: false })
		expect(native).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('absent'), native })).toBe('retry_unknown')
	})

	it('an unknown snapshot is unknown (TS-05), so a retry', () => {
		expect(nativePresence({ ws: 'no_key', kPresent: false, snapshotUnknown: true })).toBe('unknown')
	})

	it('locked on either side is a retry even when the other side is confirmed none', () => {
		expect(decideAccountReset({ ...base, idb: 'confirmed_none', native: 'confirmed_none', locked: true })).toBe('retry_unknown')
	})

	it('a timeout is a retry, not onboarding', () => {
		expect(decideAccountReset({ ...base, idb: 'confirmed_none', native: 'confirmed_none', timeout: true })).toBe('retry_unknown')
	})

	it('retries used up never become onboarding: the decision has no attempt input, so an unknown side stays a retry', () => {
		const unknown: NativePresence = 'unknown'
		for (let attempts = 0; attempts < 50; attempts += 1) {
			expect(decideAccountReset({ ...base, idb: 'confirmed_none', native: unknown })).toBe('retry_unknown')
		}
	})
})

describe('PGP alone never decides an account (Y.94)', () => {
	it('a missing PGP is not an input of the presence decision: a mnemonic on IDB still continues', () => {
		expect(decideAccountReset({ ...base, idb: idbPresenceOf('key'), native: 'confirmed_none' })).toBe('continue_account')
	})
})

describe('cleanup only after a confirmed recovery', () => {
	it('confirmed recovery and a new account established: cleanup_old', () => {
		expect(decideAccountReset({ idb: 'confirmed_none', native: 'confirmed_none', userConfirmedRecovery: true, newAccountEstablished: true })).toBe('cleanup_old')
	})

	it('a confirmed recovery without the new account: onboarding, no cleanup', () => {
		expect(decideAccountReset({ idb: 'confirmed_none', native: 'confirmed_none', userConfirmedRecovery: true, newAccountEstablished: false })).toBe('onboarding')
	})
})

describe('Y.106: residue and kPresent (readable mnemonic is has; a residue without a readable mnemonic is unknown; confirmed none needs kPresent false)', () => {
	it('a readable mnemonic on the IDB side is has: the original account continues, even when the native side confirms none', () => {
		const idb = idbPresenceOf(idbSignalOf({ status: 'loaded', keyPresent: true }))
		expect(idb).toBe('has')
		expect(decideAccountReset({ ...base, idb, native: 'confirmed_none' })).toBe('continue_account')
	})

	it('an account record without a readable mnemonic is unknown: retry, never onboarding', () => {
		const idb = idbPresenceOf(idbSignalOf({ status: 'loaded', accountPresent: true }))
		expect(idb).toBe('unknown')
		expect(decideAccountReset({ ...base, idb, native: 'confirmed_none' })).toBe('retry_unknown')
	})

	it('no_key without kPresent is not confirmed none: retry, never onboarding', () => {
		const native = nativePresence({ ws: 'no_key', snapshotUnknown: false })
		expect(native).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('retry_unknown')
	})

	it('no_key with kPresent true (a residue exists) is not confirmed none: retry, never onboarding', () => {
		const native = nativePresence({ ws: 'no_key', kPresent: true, snapshotUnknown: false })
		expect(native).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('retry_unknown')
	})

	it('confirmed none needs the full condition: IDB empty and native no_key with kPresent false, and nothing else', () => {
		const native = nativePresence({ ws: 'no_key', kPresent: false, snapshotUnknown: false })
		expect(native).toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('onboarding')
	})
})
