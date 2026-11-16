/**
 * The chat page's view of the Y.81 and Y.102 availability (batch 2). Pure functions: the page maps its PGP signals into the input, and reads
 * the notice, the action gate and the retry step from here. One notice at most: the PGP migration notices (pgpUpgradeRetry, pgpMigrationRetry)
 * are folded into the same Y.81 notice, so no two notices show at once.
 * Copy is a draft where marked: chat_crypto_retrying, chat_crypto_still_retrying and chat_history_unavailable await owner confirmation.
 */
import { chatCryptoAvailabilityOf, chatCryptoRetryAfter, immediateRetriesOnNetworkRestore, type ChatCryptoAvailability, type ChatCryptoInput } from './chatCryptoRetry'

export type ChatCryptoPageSignals = {
	/** pgpUpgradeState is pgp_migration_retry (Y.62). */
	pgpUpgradeRetry: boolean
	/** the PGP migration is retryable (pgpMigrationRunner). */
	pgpMigrationRetry: boolean
	/** the network is not reachable (navigator.onLine false). */
	offline: boolean
	/** the local history read succeeded. */
	localHistoryReadable: boolean
	/** the local history read succeeded and holds no item. */
	localHistoryEmpty: boolean
}

/** The Y.82 input: the PGP waiting signals decide K_pgp and the source; the page never judges the account here. */
export function cryptoInputOf(s: ChatCryptoPageSignals): ChatCryptoInput {
	const pgpWaiting = s.pgpUpgradeRetry || s.pgpMigrationRetry
	return {
		kPgpVerified: !pgpWaiting,
		pgpSource: pgpWaiting ? 'pgp_source_unavailable' : 'ok',
		offline: s.offline,
		localHistoryReadable: s.localHistoryReadable,
		localHistoryEmpty: s.localHistoryEmpty,
	}
}

/** The one notice the page shows (or none). `chat_crypto_still_retrying` is shown after the schedule, with a manual retry. */
export type ChatCryptoNotice = 'chat_crypto_retrying' | 'chat_crypto_still_retrying' | 'chat_history_unavailable' | null

export function cryptoNoticeOf(a: ChatCryptoAvailability, retryAttempt: number): ChatCryptoNotice {
	if (a.hint === null) return null
	if (a.hint === 'chat_history_unavailable') return 'chat_history_unavailable'
	return chatCryptoRetryAfter(retryAttempt) === 'manual' ? 'chat_crypto_still_retrying' : 'chat_crypto_retrying'
}

/** Y.81 1: encryption actions (send, decrypt, sign) are gated by the availability; a disabled action never runs. */
export function cryptoActionsEnabled(a: ChatCryptoAvailability): boolean {
	return a.encryptActions === 'enabled'
}

/**
 * Y.81 2: the next retry. A network that comes back online retries once at once (the page starts it); otherwise the schedule runs
 * 30 s, 2 min, 10 min, and then only a manual retry.
 */
export function nextCryptoRetry(retryAttempt: number, transition: 'offline_to_online' | 'none'): { immediate: boolean; delayMs: number | null } {
	const after = chatCryptoRetryAfter(retryAttempt)
	return { immediate: immediateRetriesOnNetworkRestore(transition) === 1, delayMs: after === 'manual' ? null : after }
}
