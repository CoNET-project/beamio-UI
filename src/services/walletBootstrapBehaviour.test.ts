/**
 * @jest-environment node
 *

 * 0.53.39 wallet bootstrap: behaviour tests of the start-up decision (replaces the source-text pins of the 0.53.39 candidate).
 * Inputs are synthetic (a generated test phrase, no real account). Only the pure rules are called: no DOM, no bridge.
 */
import { ethers } from 'ethers'
import { BRIDGE_TRUST_DEADLINE_MS, bridgeTrustReasonCode, bridgeTrustState, judgeShell, judgeShellFromNative, nativeNoKeyRoute, nativeStartRoute, prereadPageRoute } from './accountJudgement'
import { prereadFromAnswer } from './nativeRecovery'

// the public Hardhat test phrase (no funds, no account of anyone): a fixed vector, since random generation fails under jsdom
const PHRASE = 'test test test test test test test test test test test junk'
const EOA = ethers.Wallet.fromPhrase(PHRASE).address

const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

describe('account judgement (shell): the six cases of the handoff order', () => {
	it('1. IndexedDB holds a valid mnemonic: the existing account is entered', () => {
		expect(judgeShellFromNative({ idb: 'valid_mnemonic', walletState: 'present', walletStatus: 'unlocked' })).toEqual({
			account: 'has_account',
			action: 'enter',
		})
		expect(judgeShellFromNative({ idb: 'valid_mnemonic', walletState: 'not_reported', walletStatus: 'unknown' })).toEqual({
			account: 'has_account',
			action: 'enter',
		})
	})

	it('2. the native side returns a valid mnemonic that derives the EOA: the account is restored (pre-read valid)', () => {
		const out = prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA }))
		expect(out).toEqual({ kind: 'valid', eoa: EOA.toLowerCase(), phrase: PHRASE })
	})

	it('2b. a code ok answer is valid with the EOA its phrase derives (the code shape has no separate EOA field)', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA })).kind).toBe('valid')
	})

	it('3. both sides confirm no valid mnemonic: onboarding is allowed (absent answers, no key marker)', () => {
		expect(
			judgeShellFromNative({
				idb: 'absent',
				walletState: 'absent',
				walletStatus: 'no_key',
				storeEmpty: true,
				hasKey: false,
			}),
		).toEqual({ account: 'no_account', action: 'onboard', via: 'native_no_key' })
		expect(prereadFromAnswer(ack({ code: 'confirmed_missing' }))).toEqual({ kind: 'absent' })
	})

	it('3b. no_key with a key marker present, or unreadable: unknown, never onboarding', () => {
		for (const hasKey of [true, 'unknown'] as const) {
			const out = judgeShellFromNative({ idb: 'absent', walletState: 'absent', walletStatus: 'no_key', storeEmpty: true, hasKey })
			expect(out.action).toBe('retry')
			expect(out.account).toBe('undetermined')
		}
	})

	it('3c. no_key with an older shell that does not report hasKey keeps the confirmed onboarding', () => {
		expect(
			judgeShellFromNative({ idb: 'absent', walletState: 'absent', walletStatus: 'no_key', storeEmpty: true, hasKey: 'not_reported' }).action,
		).toBe('onboard')
	})

	it('4. the native side only reports `present` and has no valid mnemonic: retry, not an account, not onboarding', () => {
		const out = judgeShellFromNative({ idb: 'absent', walletState: 'present', walletStatus: 'unlocked', storeEmpty: true })
		expect(out).toEqual({ account: 'undetermined', action: 'retry' })
		expect(judgeShell('absent', 'present')).toEqual({ account: 'undetermined', action: 'retry' })
	})

	it('4b. the pre-read answers present without a phrase: unknown (retry)', () => {
		expect(prereadFromAnswer(ack({ state: 'present' })).kind).toBe('unknown')
	})

	it('5. locked: the existing passcode unlock route, never onboarding (see receipt: conflict with the handoff rule, pending rule)', () => {
		const out = judgeShellFromNative({ idb: 'absent', walletState: 'locked', walletStatus: 'locked', storeEmpty: true })
		expect(out.action).toBe('unlock')
		expect(out.account).toBe('undetermined')
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'locked' } })).toEqual({ kind: 'locked' })
	})

	it('6. read failure: unknown, retry, nothing judged absent', () => {
		expect(judgeShellFromNative({ idb: 'unavailable', walletState: 'unknown', walletStatus: 'unknown', storeEmpty: false })).toEqual({
			account: 'undetermined',
			action: 'retry',
		})
		expect(prereadFromAnswer({ kind: 'timeout' })).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: 'garbled' } }).kind).toBe('unknown')
	})
})

describe('native route after the sealed-copy check (0.53.39, rule A and B)', () => {
	it('a readable valid sealed copy: restore (the recovery flow), never onboarding', () => {
		const pre = prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA }))
		expect(nativeNoKeyRoute(pre)).toBe('restore')
	})
	it('a confirmed absence of the current record and the sealed copy: onboarding', () => {
		expect(nativeNoKeyRoute(prereadFromAnswer(ack({ code: 'confirmed_missing' })))).toBe('onboard')
	})
	it('a native lock: the passcode page (A), never onboarding and never a new wallet', () => {
		const pre = prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'locked' } })
		expect(nativeNoKeyRoute(pre)).toBe('native_locked')
	})
	it('an unreadable sealed copy, a timeout, or a refused answer: retry, never onboarding (B)', () => {
		expect(nativeNoKeyRoute(prereadFromAnswer({ kind: 'timeout' }))).toBe('retry')
		expect(nativeNoKeyRoute(prereadFromAnswer(ack({ code: 'read_error' })))).toBe('retry')
		expect(nativeNoKeyRoute(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: 'garbled' } }))).toBe('retry')
	})
})

/**
 * The native webview start route (0.53.39): the decision the native branch of init takes after the pre-read.
 * The pre-read is never a dead end: walletState, hasKey and walletStatus are read after it, and an unknown is a retry with a reason code.
 */
describe('native webview start route (0.53.39)', () => {
	const UNKNOWN_PRE = { kind: 'unknown', reason: undefined }
	const base = { walletState: 'absent' as const, hasKey: false as const, walletStatus: 'no_key' }

	it('pre-read unknown (bridge timeout or read failure): retry with reason pre_unknown, the native reads still run, never a dead end', () => {
		expect(nativeStartRoute({ ...base, pre: UNKNOWN_PRE, walletState: 'unknown' as const })).toEqual({ route: 'retry', reason: 'pre_unknown' })
	})

	it('hasKey true with no mnemonic and a confirmed absent pre-read (class i, 441f9ea4): onboarding, data kept; an unknown pre-read stays a key_marker retry; the iOS key-only shape onboards too', () => {
		const o = nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: true })
		expect(o).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(Object.keys(o).sort()).toEqual(['reason', 'route']) // no delete or clear instruction: the key marker and the key stay
		// A synthetic shape (walletState present, hasKey true, pre-read absent): not what either shell reports for key-only (see the measured shapes below);
		// class (i) all the same, since `present` only says a record exists and the pre-read says no mnemonic.
		const synthetic = nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: true, walletState: 'present' as const })
		expect(synthetic).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(Object.keys(synthetic).sort()).toEqual(['reason', 'route'])
		// PRR-06 counter examples (concrete evidence of a mnemonic or a ciphertext, so a contradiction, never onboarding): a present record that reports no
		// key marker, a pending passcode, a cipher or locked pre-read
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: 'not_reported', walletState: 'present' as const })).toEqual({ route: 'retry', reason: 'record_without_mnemonic' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: false, walletState: 'present' as const })).toEqual({ route: 'retry', reason: 'record_without_mnemonic' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: true, walletState: 'present' as const, passcodePending: true })).toEqual({ route: 'retry', reason: 'key_marker' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'cipher' }, hasKey: true, walletState: 'present' as const }).route).toBe('native_locked')
		expect(nativeStartRoute({ ...base, pre: { kind: 'locked' }, hasKey: true, walletState: 'present' as const }).route).toBe('native_locked')
		expect(nativeStartRoute({ ...base, pre: UNKNOWN_PRE, hasKey: true })).toEqual({ route: 'retry', reason: 'key_marker' })
	})

	/**
	 * The key-only shapes the two shells report (measured, 2026-11-22). A device that holds a private key and no mnemonic:
	 * Android passcodeStatus answers hasKey true and no walletState field (not_reported); walletStatus answers no_key.
	 * iOS passcodeStatus answers walletState absent and hasKey false; walletStatus answers no_key. The pre-read is absent on both.
	 * Class (i): onboarding, data kept. A read failure on either shape is a retry, never onboarding.
	 */
	it('measured key-only shape, Android (walletState not_reported, hasKey true, walletStatus no_key, pre-read absent): onboarding, data kept', () => {
		const o = nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'not_reported', hasKey: true, walletStatus: 'no_key' })
		expect(o).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(Object.keys(o).sort()).toEqual(['reason', 'route'])
	})
	it('measured key-only shape, iOS (walletState absent, hasKey false, walletStatus no_key, pre-read absent): onboarding, data kept', () => {
		const o = nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' })
		expect(o).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(Object.keys(o).sort()).toEqual(['reason', 'route'])
	})
	it('measured key-only shapes with a read failure: retry, never onboarding', () => {
		// Android: the walletStatus read fails, or the pre-read itself is unknown; hasKey true then holds as a key marker
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'not_reported', hasKey: true, walletStatus: 'unknown' })).toEqual({ route: 'retry', reason: 'key_marker' })
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'not_reported', hasKey: true, walletStatus: 'timeout' })).toEqual({ route: 'retry', reason: 'key_marker' })
		expect(nativeStartRoute({ pre: { kind: 'unknown' }, walletState: 'not_reported', hasKey: true, walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'key_marker' })
		// iOS: the walletState read fails, the walletStatus read fails, or the pre-read is unknown
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'unknown', hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'read_failed' })
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'timeout', hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'read_failed' })
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'unknown' })).toEqual({ route: 'retry', reason: 'read_failed' })
		expect(nativeStartRoute({ pre: { kind: 'unknown' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'pre_unknown' })
	})

	it('native locked (pre-read or walletState): the passcode page, never onboarding', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'locked' } })).toEqual({ route: 'native_locked', reason: 'native_locked' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'locked' as const })).toEqual({ route: 'native_locked', reason: 'native_locked' })
	})

	it('read failure (walletState, hasKey or walletStatus unreadable): retry with reason read_failed, never onboarding', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'unknown' as const })).toEqual({ route: 'retry', reason: 'read_failed' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: 'unknown' })).toEqual({ route: 'retry', reason: 'read_failed' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'timeout' })).toEqual({ route: 'retry', reason: 'read_failed' })
	})

	it('old shell without the pre-read command: legacy judgement, nothing waits', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'unknown', reason: 'unsupported' } })).toEqual({ route: 'legacy', reason: 'pre_read_unsupported' })
	})

	it('both sides confirmed no valid mnemonic (pre-read absent, no key marker, walletStatus no_key): onboarding', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' } })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: 'not_reported' })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
	})

	it('native present without a valid mnemonic: retry, not an account', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'present' as const })).toEqual({
			route: 'retry',
			reason: 'record_without_mnemonic',
		})
	})

	it('absent pre-read with walletStatus not_ready: branches on notReadyReason — key_only → local; other not_ready → retry; unavailable → read_failed', () => {
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'not_ready' })).toEqual({
			route: 'retry',
			reason: 'status_not_no_key',
		})
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'not_ready', notReadyReason: 'key_only' })).toEqual({
			route: 'local',
			reason: 'key_only',
		})
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'not_ready', notReadyReason: 'unreadable' })).toEqual({
			route: 'retry',
			reason: 'status_not_no_key',
		})
		expect(nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'unavailable' })).toEqual({ route: 'retry', reason: 'read_failed' })
	})
})

describe('bridge trust deadline (0.53.39, 3)', () => {
	it('S25: a hello that answers after 9.9 s with the identity declared completes the path (never a failure)', () => {
		expect(bridgeTrustState({ identity: 'declared', elapsedMs: 9_900 })).toEqual({ state: 'declared' })
	})
	it('an identity declared after the deadline is still trusted (the answer arrived)', () => {
		expect(bridgeTrustState({ identity: 'declared', elapsedMs: BRIDGE_TRUST_DEADLINE_MS + 5_000 })).toEqual({ state: 'declared' })
	})
	it('hello unanswered before the deadline: waiting, not a failure', () => {
		expect(bridgeTrustState({ identity: 'unanswered', elapsedMs: 9_900 })).toEqual({ state: 'waiting' })
	})
	it('identity not declared at the deadline: unknown with reason bridge_trust_timeout, never onboarding', () => {
		expect(bridgeTrustState({ identity: 'unanswered', elapsedMs: BRIDGE_TRUST_DEADLINE_MS })).toEqual({ state: 'unknown', reason: 'bridge_trust_timeout' })
		expect(bridgeTrustState({ identity: 'missing', elapsedMs: BRIDGE_TRUST_DEADLINE_MS + 1 })).toEqual({ state: 'unknown', reason: 'bridge_trust_timeout' })
	})
	it('old shell without the pre-read command: the legacy route (the shell path decides, nothing waits)', () => {
		expect(nativeStartRoute({ pre: { kind: 'unknown', reason: 'unsupported' }, walletState: 'absent', hasKey: 'not_reported', walletStatus: 'no_key' }).route).toBe('legacy')
	})
})

describe('pre-read valid path and the page copy (0.53.39, A)', () => {
	it('a page copy that exists is checked by prepareShellEntry before the native entry (loaded or locked)', () => {
		expect(prereadPageRoute('loaded')).toBe('check_record')
		expect(prereadPageRoute('locked')).toBe('check_record')
	})
	it('an unreadable page copy is unknown: wait and retry with reason page_read_failed; no native restore over the page (2)', () => {
		expect(prereadPageRoute('unavailable')).toBe('wait_retry')
	})
	it('an empty page is not checked (it would block the native restore); the restore write lands the wallet on the page', () => {
		expect(prereadPageRoute('empty')).toBe('restore_write')
	})
})

describe('native lock under the project rule (2026-11-20)', () => {
	it('PWA mnemonic valid and native locked: enters /home (the native lock does not hold the PWA)', () => {
		expect(judgeShell('valid_mnemonic', 'locked')).toEqual({ account: 'has_account', action: 'enter' })
		expect(judgeShellFromNative({ idb: 'valid_mnemonic', walletState: 'locked', walletStatus: 'locked' })).toEqual({ account: 'has_account', action: 'enter' })
	})
	it('PWA mnemonic missing and native locked: retry with the unlock entry, never onboarding', () => {
		expect(nativeStartRoute({ pre: { kind: 'locked' }, walletState: 'locked', hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'native_locked', reason: 'native_locked' })
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'locked', walletStatus: 'locked' }).action).toBe('unlock')
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'locked', walletStatus: 'locked' }).account).toBe('undetermined')
	})
	it('the native status not_ready while the PWA is missing and the pre-read confirms absent: retry / local by notReadyReason; an unknown pre-read is a retry', () => {
		const o = nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'not_ready' })
		expect(o).toEqual({ route: 'retry', reason: 'status_not_no_key' })
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'absent', hasKey: false, walletStatus: 'not_ready', notReadyReason: 'key_only' })).toEqual({
			route: 'local',
			reason: 'key_only',
		})
		expect(nativeStartRoute({ pre: { kind: 'unknown' }, walletState: 'absent', hasKey: false, walletStatus: 'not_ready' }).route).toBe('retry')
	})
})

/**
 * Fresh-install fixtures (0.53.39, 2026-11-20). iOS values are read-only derivations from SDK a2767b6 (not yet run on a simulator).
 * Android values are read-only derivations from SDK 866dec70 (walletStatus has no absent or present value; passcodeStatus has no walletState
 * field until the settle, and hasKey false can be reported before the settle). Onboarding is only on a confirmed absence on the trusted sides.
 */
describe('fresh-install fixtures: iOS (SDK a2767b6, read-only derivation)', () => {
	const IOS_FRESH = { walletState: 'absent' as const, hasKey: false as const, walletStatus: 'no_key' }
	it('snapshot ready: pre-read absent, passcodeStatus absent/hasKey false, walletStatus no_key: onboarding', () => {
		expect(nativeStartRoute({ ...IOS_FRESH, pre: { kind: 'absent' } })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
	})
	it('snapshot not ready: pre-read unknown, the same other answers: retry (pre_unknown), waits and retries; never onboarding', () => {
		expect(nativeStartRoute({ ...IOS_FRESH, pre: { kind: 'unknown' } })).toEqual({ route: 'retry', reason: 'pre_unknown' })
	})
})

describe('fresh-install fixtures: Android (SDK 866dec70, read-only derivation)', () => {
	// passcodeStatus before the settle: no walletState field (reported as not_reported), hasKey false
	const ANDROID_BEFORE_SETTLE = { walletState: 'not_reported' as const, hasKey: false as const }
	it('not_ready phase: pre-read absent, walletStatus not_ready, no record: retry unless key_only → local; an unknown pre-read in the same phase is a retry', () => {
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'absent' }, walletStatus: 'not_ready' })).toEqual({
			route: 'retry',
			reason: 'status_not_no_key',
		})
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'absent' }, walletStatus: 'not_ready', notReadyReason: 'key_only' })).toEqual({
			route: 'local',
			reason: 'key_only',
		})
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'unknown' }, walletStatus: 'not_ready' }).route).toBe('retry')
	})
	it('after the settle: pre-read absent, walletStatus no_key, no walletState field: onboarding (the absence is the walletStatus and the pre-read, not the missing field)', () => {
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'absent' }, walletStatus: 'no_key' })).toEqual({
			route: 'onboard',
			reason: 'confirmed_absent',
		})
	})
	it('pre-read unknown with walletStatus no_key: retry (pre_unknown), never onboarding', () => {
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'unknown' }, walletStatus: 'no_key' })).toEqual({
			route: 'retry',
			reason: 'pre_unknown',
		})
	})
	it('only hasKey false reported while walletStatus is unknown: retry (read_failed); hasKey alone never confirms an absence', () => {
		expect(nativeStartRoute({ ...ANDROID_BEFORE_SETTLE, pre: { kind: 'absent' }, walletStatus: 'unknown' })).toEqual({
			route: 'retry',
			reason: 'read_failed',
		})
	})
})

describe('bridge-trust wait reason code follows the state (review of be1b9c3)', () => {
	it('after the deadline with no identity: the reason is bridge_trust_timeout (not the waiting code)', () => {
		const trust = bridgeTrustState({ identity: 'unanswered', elapsedMs: BRIDGE_TRUST_DEADLINE_MS })
		expect(trust.state).toBe('unknown')
		expect(bridgeTrustReasonCode(trust.state)).toBe('bridge_trust_timeout')
	})
	it('before the deadline with no identity: the reason is bridge_trust_waiting', () => {
		const trust = bridgeTrustState({ identity: 'unanswered', elapsedMs: 9_900 })
		expect(bridgeTrustReasonCode(trust.state)).toBe('bridge_trust_waiting')
	})
	it('a declared identity has no timeout code', () => {
		expect(bridgeTrustReasonCode(bridgeTrustState({ identity: 'declared', elapsedMs: 99_000 }).state)).toBe('bridge_trust_waiting')
	})
})
