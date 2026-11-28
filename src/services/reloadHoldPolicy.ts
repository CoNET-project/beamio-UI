/**
 * the marks of the wait of a reload that the app (or the user's button) asks for while the send queue is not empty. ONE place for the numbers.
 *
 * while the queue is not empty the app's controllable reload stays suspended. The two marks below release nothing: they only choose what the status says
 * (awaitingStatusOf, used by chatWriteLock.reloadHoldAwaitingStatus and the toast). The item itself
 * keeps retrying with back-off until positive proof arrives; a system-level refresh or a killed process is accepted by the recovery from disk, not by this policy.
 */
export const AWAITING_NOTICE_AFTER_MS = 30 * 1000
export const AWAITING_LONG_AFTER_MS = 4 * 60 * 1000

/** waiting: less than 30 s; still_waiting: 30 s to 4 min; long_wait: 4 min and more; none: nothing is awaiting */
export type AwaitingStatus = 'none' | 'waiting' | 'still_waiting' | 'long_wait'

export function awaitingStatusOf(since: number | null, now: number): AwaitingStatus {
	if (since === null) return 'none'
	const waited = now - since
	if (waited >= AWAITING_LONG_AFTER_MS) return 'long_wait'
	if (waited >= AWAITING_NOTICE_AFTER_MS) return 'still_waiting'
	return 'waiting'
}
