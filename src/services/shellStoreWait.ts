/**
 * The shell's wait while its native store is not ready: a migration in progress, an import not done, or a
 * legacy store not readable. While it lasts the app shows a wait, never the storage-unavailable screen and never onboarding. When the
 * store reads ok the app enters on its own.
 */
import { backoffDelayMs } from './retryBackoff'

/** The first retry waits this long; each later one waits longer, up to the wait cap (a few tens of seconds, so an import that
 * finishes is noticed soon). The cap is never a stop: the retries go on while the store is not ready. */
export const NATIVE_STORE_WAIT_BASE_MS = 3000
export const NATIVE_STORE_WAIT_CAP_MS = 60_000

export function nativeStoreWaitDelayMs(attempt: number): number {
	return backoffDelayMs(NATIVE_STORE_WAIT_BASE_MS, attempt, NATIVE_STORE_WAIT_CAP_MS)
}

/**
 *a retry state (a store not ready, unreadable, locked, or an unknown answer) retries automatically at
 * 30 seconds, 2 minutes and 10 minutes, then waits for the user's manual retry. It never becomes onboarding, however many retries were used.
 */
export const NATIVE_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
export function nativeRetryStep(attempt: number): { kind: 'retry'; delayMs: number } | { kind: 'manual' } {
	return attempt < NATIVE_RETRY_DELAYS_MS.length ? { kind: 'retry', delayMs: NATIVE_RETRY_DELAYS_MS[attempt] } : { kind: 'manual' }
}

export type SplashDeadlineAction = 'release' | 'keep_waiting' | 'unavailable'

/**
 * What the splash deadline does. A decided gate is released. A store that is still migrating keeps the wait (iOS QA 10617: a
 * migration longer than the deadline must not show the unavailable screen). Otherwise the deadline is a storage failure.
 */
export function splashDeadlineAction(input: { decided: boolean; nativeWaiting: boolean }): SplashDeadlineAction {
	if (input.decided) return 'release'
	if (input.nativeWaiting) return 'keep_waiting'
	return 'unavailable'
}

/**
 * A refusal of the page as untrusted, on either spelling:
 * `untrusted_source` (the iOS new-line trust answer, measured) and `not_trusted` (the spec name). Both only wait: never the page store,
 * never /chat, never onboarding. Pure.
 */
export function isUntrustedSourceAnswer(message: string): boolean {
	return /shell_record_(untrusted_source|not_trusted)\b/.test(message)
}

/**
 * Unit g (rev): what a native passcode_not_provided answer does. It is a native pending-sync answer, never a landing decision:
 * the landing is decided by the PWA page store (a valid mnemonic enters /home before any native read) and by the pre-read (which never returns this
 * code). It changes no landing, holds no splash, shows no screen or button, starts no re-read, is not counted, and never reads as confirmed_missing.
 */
export function passcodeNotProvidedEffect(): { landingChanged: false; pendingSync: true; rereads: 0; screen: 'none'; button: false; counted: false } {
	return { landingChanged: false, pendingSync: true, rereads: 0, screen: 'none', button: false, counted: false }
}

/**
 * Unit g (2026-11-22): the passcode-not-provided answer, as a shell error message (`shell_record_passcode_not_provided`) or as the bare
 * native reason (`passcode_not_provided`). Pure. It carries no value and no secret.
 */
export function isPasscodeNotProvidedAnswer(message: string): boolean {
	return /(^|_)passcode_not_provided\b/.test(message)
}

/**
 * The unavailable reason of a shell storage read that threw. A store that is not ready (migrating, an import
 * not done, a legacy store not readable) waits and retries. A recovery hold stops at the recovery entry. Any other error, including
 * `no_key` from shellRecord, stops at unavailable: it never sends the user to onboarding (onboarding follows only an absent store).
 */
/**
 * The ceiling class of a shellRecordRead not_ready answer (v159 §179, v161 §181, v162 §182; vectors SRR-*, UNR-*, SHAPE-04..08):
 * - persistent: result.code "error" with sub not_ready_persistent (after 10 identical reasons in a row): an explicit error, no automatic retry;
 * - bounded: retryable true (g1_uninitialized, device_locked): at most 5 automatic re-reads at 0.5, 1, 2, 4, 8 s, then an explicit error;
 * - zero: retryable false (storage_locked, ambiguous_accounts, entitlement, other): an explicit error at once, no automatic retry.
 * An answer whose retryable is not a boolean is zero (an unrecognised shape is an explicit error, never an endless retry). Pure.
 */
export function notReadyClass(input: { persistent: boolean; retryable: unknown }): 'persistent' | 'bounded' | 'zero' {
	if (input.persistent) return 'persistent'
	return input.retryable === true ? 'bounded' : 'zero'
}

/** The automatic re-reads of a bounded not_ready: 0.5, 1, 2, 4, 8 seconds, then the explicit error (no further automatic read). */
export const NOT_READY_BOUNDED_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000]

export function shellStorageErrorReason(message: string): 'native_retry' | 'native_reading' | 'native_unreadable' | 'native_recovery_needed' | 'native_record' | 'app_update_required' | 'native_locked' | 'native_not_ready_bounded' | 'native_not_ready_final' | 'native_passcode_not_provided' {
	// v162 not_ready classes (v4): the explicit ceilings. The class is carried by the message (shell_record_not_ready_<class>).
	if (/shell_record_not_ready_zero\b|shell_record_not_ready_persistent\b/.test(message)) return 'native_not_ready_final'
	if (/shell_record_not_ready_bounded\b/.test(message)) return 'native_not_ready_bounded'
	// Retryable (Y.70 #4 and the transport): a snapshot not yet known answers not_ready; a timeout or an unanswered envelope
	// is a transient bridge state. None of these is a record error and none creates, overwrites or treats the store as empty.
	// 2026-11-17 (iOS SDK 4ed82c6 finding, spec E9.11.29-r2-2 K.3): an unreadable legacy store is an error answer, not a wait. It shows the
	// retryable unavailable page at once (no keep_waiting spinner); Try again re-runs the gate; it never onboards and deletes nothing.
	if (/shell_record_legacy_store_unreadable\b/.test(message)) return 'native_unreadable'
	// HC-LOCK (v10 §〇, §3.2): an envelope-level locked answer is the native lock, not a storage error. It is never onboarding and never the
	// storage-unavailable screen; the page waits and retries (the page evidence decides the branch, §一).
	if (/shell_record_locked\b/.test(message)) return 'native_locked'
	// HC-STORAGE-LOCK (v10 §〇, R-25 ruled): a result-level storage_locked is the native storage lock: wait and retry.
	if (/storage_locked\b/.test(message)) return 'native_retry'
	if (/shell_record_(migrating|import_not_done|not_ready|timeout|native_unavailable)\b/.test(message)) return 'native_retry'
	// Y.99 4: a read whose flag repair failed answers record_unreadable. It is unknown and retryable: the page shows the reading
	// wait with a retry, never onboarding, never a new account, never "no account". Nothing is deleted on the read path (Y.80).
	if (/shell_record_record_unreadable\b/.test(message)) return 'native_reading'
	// untrusted_source (): the shell refuses this page as untrusted. Wait and retry like native_retry: never the page store, never onboarding.
	if (isUntrustedSourceAnswer(message)) return 'native_retry'
	// the native layer refused this page (origin or frame): the page is not a trusted build, so the update prompt is shown.
	if (message.includes('shell_record_origin_refused')) return 'app_update_required'
	// Unit g (2026-11-22): the native passcode is not provided (walletStatus not_ready, shellRecordRead / shellRecordWrite / pwaWalletSync answers, the
	// passcode-locked commands). It is a not_ready class: a background wait with no screen, no button, never onboarding, never counted toward the
	// bounded not_ready re-reads, never confirmed_missing. Data is kept. The diagnostic code is passcode_not_provided, never native_record.
	if (isPasscodeNotProvidedAnswer(message)) return 'native_passcode_not_provided'
	return message.includes('needs_native_recovery') ? 'native_recovery_needed' : 'native_record'
}
