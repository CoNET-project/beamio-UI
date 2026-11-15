/**
 * Retry delays for the shell's waits. Each attempt waits longer than the last, up to a cap of a few minutes.
 * The cap is not a retry limit: a retry is never given up because of the time it has waited.
 */
export const RETRY_BACKOFF_CAP_MS = 5 * 60_000

/** The delay before attempt `attempt + 1` (attempt 0 gives the base delay), never above `capMs` (default RETRY_BACKOFF_CAP_MS). */
export function backoffDelayMs(baseMs: number, attempt: number, capMs: number = RETRY_BACKOFF_CAP_MS): number {
	const n = Math.max(0, Math.min(Math.floor(attempt), 30))
	return Math.min(baseMs * 2 ** n, capMs)
}
