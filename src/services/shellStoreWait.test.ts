/**
 * (iOS QA 10617): while the native store is not ready (a migration), the wait is kept past the splash deadline and the app
 * never shows the storage-unavailable screen for it. Once the store reads ok, the app enters. The wait cap is a few tens of seconds.
 */
import { NATIVE_RETRY_DELAYS_MS, NATIVE_STORE_WAIT_CAP_MS, nativeRetryStep, nativeStoreWaitDelayMs, shellStorageErrorReason, splashDeadlineAction } from './shellStoreWait'
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'
import { nativeStartRoute } from './accountJudgement'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('the wait while the native store is not ready', () => {
	it('the delay grows from 3 s and stops at the cap (never a stop: the retries go on)', () => {
		expect(nativeStoreWaitDelayMs(0)).toBe(3000)
		expect(nativeStoreWaitDelayMs(1)).toBe(6000)
		expect(nativeStoreWaitDelayMs(4)).toBe(48000)
		expect(nativeStoreWaitDelayMs(5)).toBe(NATIVE_STORE_WAIT_CAP_MS)
		expect(nativeStoreWaitDelayMs(200)).toBe(NATIVE_STORE_WAIT_CAP_MS)
		expect(NATIVE_STORE_WAIT_CAP_MS).toBe(60_000)
	})
})

describe('the splash deadline (12 s)', () => {
	it('a migration longer than the deadline keeps the wait: no unavailable screen (QA 10617)', () => {
		expect(splashDeadlineAction({ decided: false, nativeWaiting: true })).toBe('keep_waiting')
	})

	it('a store that is not migrating at the deadline is a storage failure (unavailable, as before)', () => {
		expect(splashDeadlineAction({ decided: false, nativeWaiting: false })).toBe('unavailable')
	})

	it('a decided gate is released, whatever the store is doing', () => {
		expect(splashDeadlineAction({ decided: true, nativeWaiting: true })).toBe('release')
		expect(splashDeadlineAction({ decided: true, nativeWaiting: false })).toBe('release')
	})
})

describe('G0 (4): the outcome of a shell read, not the source text', () => {
	it('shellRecord no_key (an envelope error) stops at unavailable, never onboarding', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: false, error: 'no_key' })
		expect(read).toEqual({ status: 'error', reason: 'no_key' })
		let msg = ''
		try {
			shellRecordAsWalletRecord(read)
		} catch (e) {
			msg = (e as Error).message
		}
		expect(msg).toBe('shell_record_no_key')
		expect(shellStorageErrorReason(msg)).toBe('native_record')
	})

	it('shellRecord no_key (a result code) stops at unavailable as well', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'no_key' } })
		expect(read.status).toBe('error')
		expect(shellStorageErrorReason('shell_record_no_key')).toBe('native_record')
	})

	it('absent is the only answer that is a confirmed empty store (onboarding follows it)', () => {
		expect(shellRecordAsWalletRecord(parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'absent' } }))).toBeNull()
	})

	it('migrating and import_not_done wait and retry; an unreadable legacy store is an unavailable page (not a wait); a recovery hold stops at the recovery entry', () => {
		expect(shellStorageErrorReason('shell_record_migrating')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_import_not_done')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_legacy_store_unreadable')).toBe('native_unreadable')
		expect(shellStorageErrorReason('shell_record_needs_native_recovery')).toBe('native_recovery_needed')
	})
})

describe('a refused origin on a shell record read shows the update prompt', () => {
	it('origin_refused maps to app_update_required (not to a native record hold)', () => {
		expect(shellStorageErrorReason('shell_record_origin_refused')).toBe('app_update_required')
	})
})


describe('#4: a shell read that is not yet decided is retryable, never a record error (0.53.5)', () => {
	it('not_ready (snapshot unknown) is native_retry', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).toBe('native_retry')
	})

	it('a timeout and an unanswered envelope are native_retry (transient bridge states)', () => {
		expect(shellStorageErrorReason('shell_record_timeout')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_native_unavailable')).toBe('native_retry')
	})

	it('the existing retry codes are unchanged', () => {
		expect(shellStorageErrorReason('shell_record_migrating')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_import_not_done')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_legacy_store_unreadable')).toBe('native_unreadable')
	})

	it('record errors stay native_record (closed, no retry): bad answer, rev, PGP private, unknown', () => {
		expect(shellStorageErrorReason('shell_record_bad_answer')).toBe('native_record')
		expect(shellStorageErrorReason('shell_record_rev_missing')).toBe('native_record')
		expect(shellStorageErrorReason('shell_record_pgp_private_in_payload')).toBe('native_record')
		expect(shellStorageErrorReason('shell_record_wallet_fields_missing')).toBe('native_record')
		expect(shellStorageErrorReason('shell_record_some_new_code')).toBe('native_record')
	})

	it('a recovery hold stays native_recovery_needed; origin refusal stays app_update_required', () => {
		expect(shellStorageErrorReason('shell_record_needs_native_recovery')).toBe('native_recovery_needed')
		expect(shellStorageErrorReason('shell_record_origin_refused')).toBe('app_update_required')
	})

	it('a not_ready is never treated as an absent store (no onboarding route)', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).not.toBe('native_record')
	})
})

describe('not_ready: positive and negative cases (0.53.5)', () => {
	it('positive: not_ready is a retryable wait, and the wait delay keeps growing to the cap (the retries go on)', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).toBe('native_retry')
		expect(nativeStoreWaitDelayMs(0)).toBeLessThan(nativeStoreWaitDelayMs(1))
		expect(nativeStoreWaitDelayMs(100)).toBe(NATIVE_STORE_WAIT_CAP_MS)
	})

	it('negative: not_ready is an error answer, never an absent store (no onboarding, no create)', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: false, error: 'not_ready' })
		expect(read).toMatchObject({ status: 'error', reason: 'not_ready' })
		expect(read.status).not.toBe('absent')
		// shellRecordAsWalletRecord returns null only for absent; an error must throw, so no empty record is ever built.
		// v168: a superseded envelope not_ready without retryable is bounded (re-reads, then the terminal), never endless
		expect(() => shellRecordAsWalletRecord(read)).toThrow('shell_record_not_ready_bounded')
	})

	it('negative: not_ready is never mapped to a store reason that would create or overwrite', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).not.toBe('native_record')
		expect(shellStorageErrorReason('shell_record_not_ready')).not.toBe('app_update_required')
	})

	it('a read answering error + record_unreadable (flag repair failed) is unknown and retryable: native_reading', () => {
		const read = parseShellRecordRead({ type: 'ack', reqId: 1, ok: true, result: { code: 'error', sub: 'record_unreadable' } })
		expect(read).toEqual({ status: 'error', reason: 'record_unreadable' })
		let msg = ''
		try {
			shellRecordAsWalletRecord(read)
		} catch (e) {
			msg = (e as Error).message
		}
		// never absent (null), so it never reaches onboarding or a new account
		expect(msg).toBe('shell_record_record_unreadable')
		expect(shellStorageErrorReason(msg)).toBe('native_reading')
	})

	it('native_reading is not a retry of the store wait, not a recovery entry, and not a record error', () => {
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_recovery_needed')
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_record')
	})

	it('Y.99 4: the native_reading screen is removed (5): the read failure is the background startup wait, never onboarding', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		expect(gate).not.toContain("storageUnavailable === 'native_reading'")
		expect(gate).toContain('startupWait(')
		const wait = gate.slice(gate.indexOf('const startupWait = (reason: string'), gate.indexOf('const startupWait = (reason: string') + 1200)
		expect(wait).not.toMatch(/onboarding|createWallet|clearIdentity/i)
	})
})

describe('the retry state runs 30 s, 2 min, 10 min, then the manual retry; used-up retries are never onboarding', () => {
	it('the cadence is 30 seconds, 2 minutes and 10 minutes, then manual', () => {
		expect(NATIVE_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000])
		expect([0, 1, 2].map((n) => nativeRetryStep(n))).toEqual([
			{ kind: 'retry', delayMs: 30_000 },
			{ kind: 'retry', delayMs: 120_000 },
			{ kind: 'retry', delayMs: 600_000 },
		])
	})

	it('after the three automatic retries the step is manual, and it stays manual (never onboarding, never an account-lost step)', () => {
		expect(nativeRetryStep(3)).toEqual({ kind: 'manual' })
		for (const n of [4, 6, 20, 100]) expect(nativeRetryStep(n)).toEqual({ kind: 'manual' })
	})

	it('the gate no longer uses the Y.104 step (6a26e7ae): the startup wait re-reads on the 2, 4, 8, 16 s then 30 s schedule; no six-retry bound, no recovery entry, no onboarding', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		expect(gate).not.toContain('const step = nativeRetryStep(attempt)')
		expect(gate).toContain('const delay = startupRetryDelayMs(attempt)')
		expect(gate).not.toContain('attempt >= 6')
		expect(gate).not.toContain('nativeStoreWaitDelayMs(attempt)')
		const at = gate.indexOf('const startupWait = (reason: string')
		const block = gate.slice(at, gate.indexOf('nativeWaitRef.current = true', at))
		expect(block).not.toContain('native_recovery_needed')
		expect(block).not.toMatch(/onboarding|createWallet|clearIdentity/i)
	})
})

describe('Y.104 3: the unknown retry branch shares the same cadence and never onboards', () => {
	// superseded (spec r2.4 item 42(3), the rule 1501): an unknown pre-read is the startup wait, which re-reads on its own
	// interval (STARTUP_WAIT_MS). The former reset-decision retry branch (nativeRetryStep) no longer decides the shell's start.
	it('an unknown pre-read is the startup wait on one interval: no onboarding, no creation entry, no own delay', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		// revised 2026-11-20 (rule, start route): the unknown pre-read is nativeStartRoute's retry (reason pre_unknown) on the same startupWait
		const at = gate.indexOf('startupWait(`native start: ${outcome.reason}`')
		expect(at).toBeGreaterThan(0)
		expect(nativeStartRoute({ pre: { kind: 'unknown' }, walletState: 'absent', hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'pre_unknown' })
		// the wait function only: up to the helpers that follow it (the confirmed-onboarding helpers, R2271), never into other start code
		const confirmAt = gate.indexOf('R2271: before an account is opened')
		const wait = gate.slice(gate.indexOf('const startupWait = '), confirmAt > 0 ? confirmAt : gate.indexOf('const init = async', 0))
		expect(wait).toContain('window.setTimeout')
		expect(wait).toContain('startupRetryDelayMs(attempt)')
		expect(wait).toContain('void initRef.current?.()')
		expect(wait).not.toMatch(/goOnboarding|createWallet|clearIdentity|native_recovery_needed|nativeStoreWaitDelayMs/)
	})
})

describe('HC-LOCK / HC-STORAGE-LOCK classification (v10 §〇, §3.2; R-25 ruled)', () => {
	it('L-REC: an envelope-level shell_record_locked is native_locked, never native_record', () => {
		expect(shellStorageErrorReason('shell_record_locked')).toBe('native_locked')
		expect(shellStorageErrorReason('shell_record_locked')).not.toBe('native_record')
	})

	it('D-7: a result-level storage_locked is native_retry (wait and retry)', () => {
		expect(shellStorageErrorReason('storage_locked')).toBe('native_retry')
	})

	it('other records are unchanged (regression)', () => {
		expect(shellStorageErrorReason('shell_record_timeout')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_origin_refused')).toBe('app_update_required')
	})
})

describe('the splash deadline does not override a decided terminal (the update prompt)', () => {
	test('a terminal decision (decided, native store waiting flag cleared) is released, never kept waiting', () => {
		expect(splashDeadlineAction({ decided: true, nativeWaiting: false })).toBe('release')
		expect(splashDeadlineAction({ decided: true, nativeWaiting: true })).toBe('release')
	})
})

describe('untrusted_source waits and retries (7590d172)', () => {
	it('shell_record_untrusted_source is native_retry, never an update prompt, never an entry', () => {
		expect(shellStorageErrorReason('shell_record_untrusted_source')).toBe('native_retry')
	})
	it('shell_record_locked stays native_locked', () => {
		expect(shellStorageErrorReason('shell_record_locked')).toBe('native_locked')
	})
})
