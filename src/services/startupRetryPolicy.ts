/**
 * r92 step 5: an unknown start is never given up and never goes to onboarding. The automatic re-read
 * backs off 2, 4, 8, 16 seconds, then repeats every 30 seconds for as long as the start stays unknown. Each re-read re-evaluates the
 * start from the beginning (an init skip is never permanent). Pure: the attempt number is 1 for the first automatic retry.
 */
export const STARTUP_RETRY_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000]
export const STARTUP_RETRY_STEADY_MS = 30_000

export function startupRetryDelayMs(attempt: number): number {
	if (!Number.isInteger(attempt) || attempt < 1) return STARTUP_RETRY_BACKOFF_MS[0]
	return attempt <= STARTUP_RETRY_BACKOFF_MS.length ? STARTUP_RETRY_BACKOFF_MS[attempt - 1] : STARTUP_RETRY_STEADY_MS
}

/** The window event the App's init skip raises when a start stays unknown: the gate then shows its visible retry button. */
export const STARTUP_RETRY_OFFER_EVENT = 'beamio:startup-retry-offer'
