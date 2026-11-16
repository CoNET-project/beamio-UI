/**
 * Chat crypto availability and retry (Y.81, CA-01 to CA-06; Y.102) and the storage-derived lock retry (Y.83). Pure functions; the chat page
 * and the gate call them (their wiring is a separate change). PGP is a chat capability only (Y.94); the account is not judged here.
 */
export type ChatCryptoInput = {
	kPgpVerified: boolean
	pgpSource: 'ok' | 'pgp_source_unavailable' | 'none'
	offline: boolean
	/** the local history read (R_db) succeeded. */
	localHistoryReadable: boolean
	/** the read succeeded and holds no item. Only meaningful when localHistoryReadable is true (Y.102 2). */
	localHistoryEmpty: boolean
}

/**
 * The notice keys. `chat_crypto_retrying` is the Y.81 1 notice (crypto not complete). `chat_history_unavailable` is the Y.102 3 notice
 * (crypto complete, local history not readable); its copy is a draft until the owner confirms it.
 */
export type ChatCryptoHint = 'chat_crypto_retrying' | 'chat_history_unavailable' | null

export type ChatCryptoAvailability = {
	/** readwrite: history and actions. readonly: local history only. hidden_with_retry: no history shown, a notice shows (never "no session"). */
	history: 'readwrite' | 'readonly' | 'hidden_with_retry'
	encryptActions: 'enabled' | 'disabled'
	/** the non-blocking notice key; null when the chat is fully available and the history is readable (Y.102 1). */
	hint: ChatCryptoHint
	/** the retry schedule runs when a notice is shown; never L (useL false). */
	retry: 'schedule' | null
	/** true for a normal empty session: the history reads and holds no item, and no notice applies (Y.102 2). */
	emptySession: boolean
	useL: false
}

/**
 * CA-01 to CA-04 (Y.81 1) and Y.102. The keys are never read from L (useL is always false, Y.81 1 and §25.52.3).
 * - crypto complete, history readable (empty or not): no notice, no retry (CA-01; Y.102 1 and 2).
 * - crypto complete, history not readable: the history notice and the schedule, separate from the crypto notice (Y.102 3).
 * - crypto not complete: read only when the history is readable (CA-02, CA-03), the crypto notice and the schedule; actions disabled.
 * - crypto not complete and history not readable: never shown as "no session" (CA-04): the crypto notice and the schedule.
 */
export function chatCryptoAvailabilityOf(input: ChatCryptoInput): ChatCryptoAvailability {
	const full = input.kPgpVerified && input.pgpSource === 'ok'
	const readable = input.localHistoryReadable
	const emptySession = readable && input.localHistoryEmpty
	if (full) {
		if (!readable) {
			return { history: 'hidden_with_retry', encryptActions: 'enabled', hint: 'chat_history_unavailable', retry: 'schedule', emptySession: false, useL: false }
		}
		return { history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, emptySession, useL: false }
	}
	if (!readable) {
		// CA-04: no local history is never shown as "no session".
		return { history: 'hidden_with_retry', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', emptySession: false, useL: false }
	}
	return { history: 'readonly', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', emptySession, useL: false }
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
