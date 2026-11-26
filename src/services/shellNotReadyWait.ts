/**
 * Shell guard for a native walletStatus `not_ready` (accepted; review).
 *
 * In a shell, `not_ready`, and any unknown walletStatus (unknown, unavailable, a read failure, a timeout or unreported) is an unknown,
 * retryable native state. Unknown is treated as unknown: fail closed. It must never reach the
 * account creation or the recovery entries, and never a native write. The start therefore waits and retries (startup page, the retry
 * button, the usual backoff). A valid mnemonic on the page (`has_account`) still enters the app as before (rule 2026-11-20).
 *
 * Pure: the caller passes the shell flag, the native walletStatus and the judged presence.
 */
/**
 * 2026-11-21 (stricter form): in a shell, any walletStatus that is not an explicit `no_key` holds the start when the page has no
 * valid mnemonic (presence not has_account). This covers not_ready, unknown, unavailable, timeout, read failures, unreported, and also
 * locked and unlocked, so a native key that already exists is never overwritten by a creation or recovery entry. Only an explicit
 * `no_key` (native confirmed absent) may reach the onboarding entries.
 *
 * r11 (2026-11-26): `not_ready` + `notReadyReason: key_only` is **not** held here — the caller enters local mode (address-only home)
 * instead of waiting for the SDK to reach `no_key` or opening onboarding. Other `not_ready` reasons still wait.
 */
export function shellNotReadyWaitReason(input: {
	isShell: boolean
	walletStatus: string
	presence: string
	/** When walletStatus is `not_ready`, the closed-set reason from the native answer. */
	notReadyReason?: string | null
}): string | null {
	if (!input.isShell) return null
	if (input.walletStatus === 'no_key') return null
	if (input.presence === 'has_account') return null
	// r11: key_only is local mode (caller), not a wait-for-no_key hold
	if (input.walletStatus === 'not_ready' && input.notReadyReason === 'key_only') return null
	return 'native walletStatus not explicit no_key (shell): wait and retry, no creation, recovery or import entry'
}
