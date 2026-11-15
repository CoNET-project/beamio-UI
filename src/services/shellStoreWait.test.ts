/**
 * (iOS QA 10617): while the native store is not ready (a migration), the wait is kept past the splash deadline and the app
 * never shows the storage-unavailable screen for it. Once the store reads ok, the app enters. The wait cap is a few tens of seconds.
 */
import { NATIVE_STORE_WAIT_CAP_MS, nativeStoreWaitDelayMs, shellStorageErrorReason, splashDeadlineAction } from './shellStoreWait'
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'

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

