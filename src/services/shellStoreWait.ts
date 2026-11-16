/**
 * The shell's wait while its native store is not ready: a migration in progress, an import not done, or a
 * legacy store not readable. While it lasts the app shows a wait, never the storage-unavailable screen and never onboarding. When the
 * store reads ok the app enters on its own.
 */
import { backoffDelayMs } from './retryBackoff'

/** The first retry waits this long; each later one waits longer, up to the wait cap (a few tens of seconds, so an import that
 *  finishes is noticed soon). The cap is never a stop: the retries go on while the store is not ready. */
export const NATIVE_STORE_WAIT_BASE_MS = 3000
export const NATIVE_STORE_WAIT_CAP_MS = 60_000

export function nativeStoreWaitDelayMs(attempt: number): number {
	return backoffDelayMs(NATIVE_STORE_WAIT_BASE_MS, attempt, NATIVE_STORE_WAIT_CAP_MS)
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
 * The unavailable reason of a shell storage read that threw. A store that is not ready (migrating, an import
 * not done, a legacy store not readable) waits and retries. A recovery hold stops at the recovery entry. Any other error, including
 * `no_key` from shellRecord, stops at unavailable: it never sends the user to onboarding (onboarding follows only an absent store).
 */
export function shellStorageErrorReason(message: string): 'native_retry' | 'native_recovery_needed' | 'native_record' | 'app_update_required' {
	// Retryable (Y.70 #4 and the transport): a snapshot not yet known answers not_ready; a timeout or an unanswered envelope
	// is a transient bridge state. None of these is a record error and none creates, overwrites or treats the store as empty.
	if (/shell_record_(migrating|import_not_done|legacy_store_unreadable|not_ready|timeout|native_unavailable)\b/.test(message)) return 'native_retry'
	// the native layer refused this page (origin or frame): the page is not a trusted build, so the update prompt is shown.
	if (message.includes('shell_record_origin_refused')) return 'app_update_required'
	return message.includes('needs_native_recovery') ? 'native_recovery_needed' : 'native_record'
}
