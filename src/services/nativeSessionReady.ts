/**
 * Which native chat sessions this page has already made ready (0.53.58, iOS cold start: the conversation list stayed on "Loading
 * conversations…" for 90 s).
 *
 * The cold start first makes the native wallet ready with a one-shot identity-only init (nativeWallet.reachNativeWallet). That init
 * runs the whole native session start: the listen, the inbox replay and the history key (`[history] ready` log). Its page client is
 * thrown away at once, so those events reach nobody. The chat start that follows sends a second init for the same account; the native
 * module answers it as idempotent ("changes nothing") and logs no `[history] ready` again. The page's history bridge waits for that log
 * (a load sent before the key exists is dropped without an answer), so it waited for its full 90 s limit.
 *
 * This registry remembers, per bridge and account, when an init of this page was answered. A later client of the same account then knows
 * that its module session is not new and that the ready log will not come, and may take the key as ready after a short settle. The
 * registry holds no key and no content. It is cleared by the global teardown (logout / lock): after that the next init is a new session.
 */

/** Settle time after the earlier init's answer: the native key derivation runs right after the ready answer and takes milliseconds. */
export const HISTORY_ASSUMED_READY_SETTLE_MS = 1500

const readyAt = new Map<string, number>()

const keyOf = (bridgeLabel: string, eoa: string): string => `${bridgeLabel}|${String(eoa || '').toLowerCase()}`

/** An init of this bridge and account was answered (ready): the native session is up. */
export function noteNativeSessionReady(bridgeLabel: string, eoa: string, now: number = Date.now()): void {
	if (!eoa) return
	readyAt.set(keyOf(bridgeLabel, eoa), now)
}

/** When the earlier init of this bridge and account was answered, or null when this page has not made that session ready. */
export function nativeSessionReadySince(bridgeLabel: string, eoa: string): number | null {
	if (!eoa) return null
	const at = readyAt.get(keyOf(bridgeLabel, eoa))
	return at === undefined ? null : at
}

/** How long a new client still waits for the ready log before it takes the key as ready (0 when the settle time has passed). */
export function assumedReadyDelayMs(since: number, now: number = Date.now()): number {
	return Math.max(0, HISTORY_ASSUMED_READY_SETTLE_MS - (now - since))
}

/** The global teardown (logout, lock) ends the native session: the next init starts a new one and logs its own ready. */
export function forgetNativeSessionReady(): void {
	readyAt.clear()
}
