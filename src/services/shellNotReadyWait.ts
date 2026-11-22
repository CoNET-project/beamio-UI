/**
 * Shell guard for a native walletStatus `not_ready`.
 *
 * In a shell, `not_ready`, and any unknown walletStatus (unknown, unavailable, a read failure, a timeout or unreported) is an unknown,
 * retryable native state. Unknown is treated as unknown: fail closed. It must never reach the
 * account creation or the recovery entries, and never a native write. The start therefore waits and retries (startup page, the retry
 * button, the usual backoff). A valid mnemonic on the page (`has_account`) still enters the app as before.
 *
 * Pure: the caller passes the shell flag, the native walletStatus and the judged presence.
 */
/**
 * Stricter form: in a shell, any walletStatus that is not an explicit `no_key` holds the start when the page has no
 * valid mnemonic (presence not has_account). This covers not_ready, unknown, unavailable, timeout, read failures, unreported, and also
 * locked and unlocked, so a native key that already exists is never overwritten by a creation or recovery entry. Only an explicit
 * `no_key` (native confirmed absent) may reach the onboarding entries.
 */
export function shellNotReadyWaitReason(input: {
	isShell: boolean
	walletStatus: string
	presence: string
}): string | null {
	if (!input.isShell) return null
	if (input.walletStatus === 'no_key') return null
	if (input.presence === 'has_account') return null
	return 'native walletStatus not explicit no_key (shell): wait and retry, no creation, recovery or import entry'
}
