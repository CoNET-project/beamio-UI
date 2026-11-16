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

describe('Y.107: residues never block onboarding; only a readable mnemonic is has; a failed read is unknown', () => {
	it('a readable mnemonic on the IDB side is has: the original account continues, even when the native side confirms none', () => {
		const idb = idbPresenceOf(idbSignalOf({ status: 'loaded', keyPresent: true }))
		expect(idb).toBe('has')
		expect(decideAccountReset({ ...base, idb, native: 'confirmed_none' })).toBe('continue_account')
	})

	it('a successful IDB read with an account record and no mnemonic is confirmed none (residue does not block): onboarding', () => {
		const idb = idbPresenceOf(idbSignalOf({ status: 'loaded', accountPresent: true }))
		expect(idb).toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb, native: 'confirmed_none' })).toBe('onboarding')
	})

	// Y.151 (PNK-01..05) supersedes Y.108 for kPresent true: only kPresent false is confirmed none (onboarding); kPresent true is never none.
	it('Y.151: no_key with kPresent false and IDB empty is onboarding; kPresent true is never onboarding', () => {
		const none = nativePresence({ ws: 'no_key', kPresent: false, snapshotUnknown: false })
		expect(none).toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native: none })).toBe('onboarding')
		const held = nativePresence({ ws: 'no_key', kPresent: true, snapshotUnknown: false })
		expect(held).not.toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native: held })).not.toBe('onboarding')
	})

	it('no_key with kPresent missing is a read error: retry, never onboarding (Y.151)', () => {
		const native = nativePresence({ ws: 'no_key', snapshotUnknown: false })
		expect(native).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('retry_unknown')
	})

	it('R43: a parseable document with no key and no account is a successful read with no mnemonic: IDB confirmed none, so onboarding', () => {
		expect(idbPresenceOf(idbSignalOf({ status: 'loaded' }))).toBe('confirmed_none')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'loaded' })), native: 'confirmed_none' })).toBe('onboarding')
	})

	it('R43: an unparseable or structure-mismatched IDB entry (invalid_document) is corrupt, unknown: retry, never onboarding', () => {
		expect(idbPresenceOf(idbSignalOf({ status: 'unavailable', reason: 'invalid_document' }))).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'unavailable', reason: 'invalid_document' })), native: 'confirmed_none' })).toBe('retry_unknown')
	})

	it('a read error or a lock is unknown: retry, never onboarding', () => {
		expect(idbPresenceOf(idbSignalOf({ status: 'unavailable', reason: 'read_error' }))).toBe('unknown')
		expect(idbPresenceOf(idbSignalOf({ status: 'locked' }))).toBe('unknown')
	})

	it('a not_ready native read (unreadable) is unknown: retry, never onboarding, even with IDB empty', () => {
		const native = nativePresence({ ws: 'not_ready', reason: 'unreadable', snapshotUnknown: false })
		expect(native).toBe('unknown')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('retry_unknown')
	})
})

describe('G2 (R45): a native walletStatus locked answer with a readable mnemonic continues the original account, never a passcode trap', () => {
	const { readFileSync } = require('fs') as typeof import('fs')
	const { join } = require('path') as typeof import('path')

	it('a locked native answer is has, so the account continues (Y.107 1)', () => {
		const native = nativePresence({ ws: 'locked', snapshotUnknown: false })
		expect(native).toBe('has')
		expect(decideAccountReset({ ...base, idb: idbPresenceOf(idbSignalOf({ status: 'empty' })), native })).toBe('continue_account')
	})

	it('the passcode page stays keyed to walletState locked only (GY), and the continue branch takes the EOA from a locked or unlocked answer', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		expect(gate).toContain("if (shellWalletState === 'locked' && identity === 'declared') {")
		expect(gate).toContain("(shellNativeState.status === 'locked' || shellNativeState.status === 'unlocked') && 'eoa' in shellNativeState")
	})
})
