/**
 * (iOS QA 10617): while the native store is not ready (a migration), the wait is kept past the splash deadline and the app
 * never shows the storage-unavailable screen for it. Once the store reads ok, the app enters. The wait cap is a few tens of seconds.
 */
import { NATIVE_STORE_WAIT_CAP_MS, nativeStoreWaitDelayMs, shellStorageErrorReason, splashDeadlineAction } from './shellStoreWait'
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'
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

	it('migrating, import_not_done and legacy_store_unreadable wait and retry; a recovery hold stops at the recovery entry', () => {
		expect(shellStorageErrorReason('shell_record_migrating')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_import_not_done')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_legacy_store_unreadable')).toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_needs_native_recovery')).toBe('native_recovery_needed')
	})
})

describe('a refused origin on a shell record read shows the update prompt', () => {
	it('origin_refused maps to app_update_required (not to a native record hold)', () => {
		expect(shellStorageErrorReason('shell_record_origin_refused')).toBe('app_update_required')
	})
})


describe('Y.70 #4: a shell read that is not yet decided is retryable, never a record error (0.53.5)', () => {
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
		expect(shellStorageErrorReason('shell_record_legacy_store_unreadable')).toBe('native_retry')
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

describe('not_ready (Y.70 #4): positive and negative cases (0.53.5)', () => {
	it('positive: not_ready is a retryable wait, and the wait delay keeps growing to the cap (the retries go on)', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).toBe('native_retry')
		expect(nativeStoreWaitDelayMs(0)).toBeLessThan(nativeStoreWaitDelayMs(1))
		expect(nativeStoreWaitDelayMs(100)).toBe(NATIVE_STORE_WAIT_CAP_MS)
	})

	it('negative: not_ready is an error answer, never an absent store (no onboarding, no create)', () => {
		const read = parseShellRecordRead({ type: 'ack', ok: false, error: 'not_ready' })
		expect(read).toEqual({ status: 'error', reason: 'not_ready' })
		expect(read.status).not.toBe('absent')
		// shellRecordAsWalletRecord returns null only for absent; an error must throw, so no empty record is ever built.
		expect(() => shellRecordAsWalletRecord(read)).toThrow('shell_record_not_ready')
	})

	it('negative: not_ready is never mapped to a store reason that would create or overwrite', () => {
		expect(shellStorageErrorReason('shell_record_not_ready')).not.toBe('native_record')
		expect(shellStorageErrorReason('shell_record_not_ready')).not.toBe('app_update_required')
	})

	it('Y.99 4: a read answering error + record_unreadable (flag repair failed) is unknown and retryable: native_reading', () => {
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

	it('Y.99 4: native_reading is not a retry of the store wait, not a recovery entry, and not a record error', () => {
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_retry')
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_recovery_needed')
		expect(shellStorageErrorReason('shell_record_record_unreadable')).not.toBe('native_record')
	})

	it('Y.99 4: the gate shows the reading copy with a retry, and never routes it to onboarding', () => {
		const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const at = gate.indexOf("storageUnavailable === 'native_reading'")
		expect(at).toBeGreaterThan(0)
		const block = gate.slice(at, at + 700)
		expect(block).toContain("tu('native_reading_body')")
		expect(block).toContain('void init()')
		expect(block).not.toMatch(/onboarding|createWallet|clearIdentity/i)
		const locale = JSON.parse(readFileSync(join(__dirname, '..', 'locale', 'zh-CN.json'), 'utf8'))
		expect(locale.ui.native_reading_body).toBe('正在读取，请稍后重试')
	})
})
