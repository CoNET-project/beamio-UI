/**
 * Completion signal for the chat history preheat. The SDK's `history.load()` publishes the most recent (tail) batch through the
 * history buffer with `isTail: true`, even when it is empty (history.ts load: `emit.buffer(…, [], true)` when there is nothing to load).
 * A tail batch therefore means: the on-chain pointer was read, the IPFS index was fetched and the tail was decrypted for that worker
 * client. Older (backfill) batches do not count. The bridge calls `noteTail(client)` from its buffer handler and `await` from the preheat.
 *
 * Waiting is bounded: no tail within `timeoutMs` resolves false. A tail already seen for the active client resolves true at once,
 * so a late caller never waits for a batch that has already been delivered. SYNTHETIC values only.
 */
export interface HistoryTailWaiter {
	/** Called for each buffer batch of the client that produced it. Only `isTail` batches complete the waiters. */
	noteTail(client: unknown, isTail: boolean | undefined): void
	/** True once the tail batch was delivered for `client`. */
	deliveredFor(client: unknown): boolean
	/** Resolves true on the tail of the active client, false on timeout. */
	await(activeClient: () => unknown, timeoutMs: number): Promise<boolean>
}

export function createHistoryTailWaiter(setTimer: typeof setTimeout = setTimeout, clearTimer: typeof clearTimeout = clearTimeout): HistoryTailWaiter {
	let delivered: unknown = null
	// each waiter remembers the client it awaits: a tail of another client never completes it
	const waiters = new Map<(ok: boolean) => void, () => unknown>()
	return {
		noteTail(client, isTail) {
			if (!isTail || !client) return
			delivered = client
			for (const [w, active] of Array.from(waiters.entries())) if (active() === client) w(true)
		},
		deliveredFor(client) {
			return !!client && delivered === client
		},
		await(activeClient, timeoutMs) {
			const client = activeClient()
			if (client && delivered === client) return Promise.resolve(true)
			return new Promise<boolean>((resolve) => {
				const done = (ok: boolean) => {
					clearTimer(timer)
					waiters.delete(done)
					resolve(ok)
				}
				const timer = setTimer(() => done(false), timeoutMs)
				waiters.set(done, activeClient)
			})
		},
	}
}
