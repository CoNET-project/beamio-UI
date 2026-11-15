/**
 * The account-info "temporarily unavailable"state: the App init gave up its capped reads. The screen shows a notice
 * with a manual retry. It is not "no account" and not a terminal state; the retry starts the init again. Copy is pending the owner.
 */
export const ACCOUNT_INFO_RETRY_EVENT = 'beamio:account-info-retry'

export type AccountInfoUnavailableReason = 'no_account' | 'network_error'

let current: AccountInfoUnavailableReason | null = null
const listeners = new Set<() => void>()

export function getAccountInfoUnavailable(): AccountInfoUnavailableReason | null {
	return current
}

export function setAccountInfoUnavailable(reason: AccountInfoUnavailableReason | null): void {
	if (reason === current) return
	current = reason
	for (const listener of [...listeners]) listener()
}

export function subscribeAccountInfoUnavailable(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** The notice's retry button: the App listens for this event and runs its init again. */
export function requestAccountInfoRetry(): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new Event(ACCOUNT_INFO_RETRY_EVENT))
}
