/**
 * Limit of the automatic chat start retries in a shell.
 *
 * A start that fails counts one failure. The sixth consecutive failure stops the automatic retries: the page shows "chat is unavailable"
 * with a manual retry button. A success, or the manual retry, starts the count again. Continuation steps of a start (a restored PGP, a
 * completed G1 init) are not failures and do not count. Pure except for the small store that the notice reads.
 */

export const SHELL_CHAT_RETRY_LIMIT = 6

export interface ShellRetryCap {
	/** Counts one failure. `retry` while the limit is not reached; `stop` on the limit (no further automatic retry). */
	failed(): 'retry' | 'stop'
	/** A start succeeded: the count starts again. */
	succeeded(): void
	/** The manual retry: the count starts again. */
	reset(): void
	count(): number
}

export function createShellRetryCap(limit: number = SHELL_CHAT_RETRY_LIMIT): ShellRetryCap {
	let failures = 0
	return {
		failed(): 'retry' | 'stop' {
			failures += 1
			return failures >= limit ? 'stop' : 'retry'
		},
		succeeded(): void {
			failures = 0
		},
		reset(): void {
			failures = 0
		},
		count(): number {
			return failures
		},
	}
}

// The notice state: true when the automatic retries stopped and the page waits for the manual retry.
let exhausted = false
const exhaustedListeners = new Set<(value: boolean) => void>()
// The handler of the manual retry, set by the chat module (it owns the start arguments).
let retryNow: (() => void) | null = null

export function getShellRetryExhausted(): boolean {
	return exhausted
}

export function setShellRetryExhausted(next: boolean): void {
	if (next === exhausted) return
	exhausted = next
	for (const listener of [...exhaustedListeners]) listener(next)
}

export function subscribeShellRetryExhausted(listener: (value: boolean) => void): () => void {
	exhaustedListeners.add(listener)
	return () => {
		exhaustedListeners.delete(listener)
	}
}

export function registerShellRetryNow(handler: (() => void) | null): void {
	retryNow = handler
}

/** The notice's manual retry. Does nothing until the chat module has registered its handler. */
export function requestShellRetryNow(): void {
	retryNow?.()
}
