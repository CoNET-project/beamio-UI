/**
 * Cold-start backoff of the page for a `not_ready` read.
 *
 * Applies to the retryable not_ready of identityPublic, walletStatus and nativeMnemonicPreread (a snapshot not ready yet). The first attempt is
 * at once; after each answer it waits 1, 2, 4, 8, 16 s, then 16 s each time (counted from the answer, not from the send). The total window is
 * 180 s (the native init was seen at 130 s; it replaces the 60 s of the first text). The window used up stops the automatic retries: the page
 * shows its "try later" entry and polls read-only every 30 s while that is visible and the app is in the foreground; a manual retry only reads.
 * A count of attempts is NOT a stop condition. One command is in flight at a time (the caller's own single flight). A reset (account switch,
 * back to the foreground, a success, a manual retry) starts the clock again. Hard refusals (bad_identity, bad_request, not_available, ...) do not
 * come here. Only the attempt number and the elapsed time are ever logged.
 */
export const COLD_START_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]
export const COLD_START_STEADY_MS = 16_000
export const COLD_START_WINDOW_MS = 180_000

export type ColdStartStep = { kind: 'wait'; delayMs: number; attempt: number; elapsedMs: number } | { kind: 'exhausted'; attempt: number; elapsedMs: number }

export type ColdStartKey = 'identityPublic' | 'walletStatus' | 'nativeMnemonicPreread' | 'historyCorpus' | 'pgpMigrate' | 'pgpRestoreEvaluate'

export interface ColdStartBackoff {
	/** Called after an attempt answered not_ready: the next wait, or `exhausted` when the 60 s window is used up. */
	next(key: ColdStartKey): ColdStartStep
	/** A success, an account switch, the foreground or a manual retry: the clock of this command starts again. */
	reset(key?: ColdStartKey): void
	attempts(key: ColdStartKey): number
}

export function createColdStartBackoff(now: () => number = Date.now): ColdStartBackoff {
	const state = new Map<ColdStartKey, { startedAt: number; attempts: number }>()
	return {
		next(key) {
			let s = state.get(key)
			if (!s) {
				s = { startedAt: now(), attempts: 0 }
				state.set(key, s)
			}
			const elapsedMs = now() - s.startedAt
			if (elapsedMs >= COLD_START_WINDOW_MS) return { kind: 'exhausted', attempt: s.attempts, elapsedMs }
			const base = s.attempts < COLD_START_BACKOFF_MS.length ? COLD_START_BACKOFF_MS[s.attempts] : COLD_START_STEADY_MS
			// the last wait is cut to the end of the window, so the window is never overrun
			const delayMs = Math.min(base, COLD_START_WINDOW_MS - elapsedMs)
			s.attempts += 1
			return { kind: 'wait', delayMs, attempt: s.attempts, elapsedMs }
		},
		reset(key) {
			if (key) state.delete(key)
			else state.clear()
		},
		attempts(key) {
			return state.get(key)?.attempts ?? 0
		},
	}
}
