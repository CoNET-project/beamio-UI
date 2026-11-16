/**
 * Chat crypto availability and retry (Y.81, CA-01 to CA-06) and the storage-derived lock retry (Y.83). Pure functions; the chat page and
 * the gate call them (their wiring is a separate change). PGP is a chat capability only (Y.94); the account is not judged here.
 */
export type ChatCryptoInput = {
	kPgpVerified: boolean
	pgpSource: 'ok' | 'pgp_source_unavailable' | 'none'
	offline: boolean
	localHistoryAvailable: boolean
}
export type ChatCryptoAvailability = {
	/** readwrite: history and actions. readonly: local history only. hidden_with_retry: no history shown, the retry hint shows (never "no session"). */
	history: 'readwrite' | 'readonly' | 'hidden_with_retry'
	encryptActions: 'enabled' | 'disabled'
	/** the non-blocking notice key (Y.81 1); null when the chat is fully available. */
	hint: 'chat_crypto_retrying' | null
	/** the retry schedule runs when the chat is not fully available; never L (useL false). */
	retry: 'schedule' | null
	useL: false
}

/** CA-01 to CA-04 (Y.81 1). The keys are never read from L (useL is always false, Y.81 1 and §25.52.3). */
export function chatCryptoAvailabilityOf(input: ChatCryptoInput): ChatCryptoAvailability {
	const full = input.kPgpVerified && input.pgpSource === 'ok'
	// CA-04: no local history is never shown as "no session". The notice and the schedule apply whatever the crypto state (R35).
	if (!input.localHistoryAvailable) {
		return { history: 'hidden_with_retry', encryptActions: full ? 'enabled' : 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', useL: false }
	}
	if (full) return { history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, useL: false }
	return {
		history: input.localHistoryAvailable ? 'readonly' : 'hidden_with_retry',
		encryptActions: 'disabled',
		hint: 'chat_crypto_retrying',
		retry: 'schedule',
		useL: false,
	}
}

/** The retry delays (Y.81 2, §25.52PR.1.1): 30 seconds, 2 minutes, 10 minutes; then the user retries by hand (CA-05). */
export const CHAT_CRYPTO_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
/** The delay before the next automatic retry after `attempt` earlier retries; 'manual' once the schedule is used up. */
export function chatCryptoRetryAfter(attempt: number): number | 'manual' {
	return attempt < CHAT_CRYPTO_RETRY_DELAYS_MS.length ? CHAT_CRYPTO_RETRY_DELAYS_MS[attempt] : 'manual'
}

/** CA-06 (Y.81 2): a network restored from offline to online retries once, at once (started by the page). */
export function immediateRetriesOnNetworkRestore(transition: 'offline_to_online' | 'none'): 0 | 1 {
	return transition === 'offline_to_online' ? 1 : 0
}

/**
 * Y.83 4: a storage-derived lock (marker_missing, record_missing; not_ready with unreadable) is retried on the same schedule. After the three
 * automatic retries the page shows the recovery entry, which only the user starts (needs_native_recovery). It never enters onboarding and
 * never answers `locked` (Y.83 2, 5).
 */
export type StorageLockAction = { kind: 'retry'; delayMs: number } | { kind: 'recovery_entry' }
export function storageLockActionAt(attempt: number): StorageLockAction {
	if (attempt < 3) return { kind: 'retry', delayMs: CHAT_CRYPTO_RETRY_DELAYS_MS[attempt] }
	return { kind: 'recovery_entry' }
}
