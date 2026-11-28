/**
 * "Loading earlier messages…" never ended because nothing ever ran the library's full sync (the only writer of `syncComplete`).
 * Chosen fix: run the SDK's own syncLocal once per history client, when a library page first reports olderState 'pending'.
 * Why not just set syncComplete when the oldest local row is reached: that row being the oldest LOCAL row says nothing about older records
 * that are in the index but not yet in the library; only syncLocal knows (it sets syncComplete only if every index record was processed).
 *
 * Guarantees: at most one run at a time, at most one attempt per client (a failed run is not retried in a loop), fire-and-forget (the
 * first screen never waits for it), no client yet = nothing consumed.
 */
export type LocalSyncHistory = { syncLocal?: () => Promise<void> } | null | undefined

export type LocalSyncOnce = {
	/** true = this call ran a sync that finished ok; false = it ran and failed or the client cannot sync; null = already attempted / running / no client. */
	run: () => Promise<boolean | null>
}

export const createLocalSyncOnce = (getHistory: () => LocalSyncHistory): LocalSyncOnce => {
	let attemptedFor: object | null = null
	return {
		run: async () => {
			const h = getHistory()
			if (!h || typeof h !== 'object') return null
			if (attemptedFor === h) return null
			attemptedFor = h
			if (typeof h.syncLocal !== 'function') return false
			try {
				await h.syncLocal()
				return true
			} catch {
				return false
			}
		},
	}
}

/**
 * After a library page read: when the page says older rows are still pending, run the sync once (not awaited by the caller)
 * and, only if this call ran it successfully, ask for exactly one re-read via `reread`. Returns the promise for tests; the UI ignores it.
 */
export const followUpOlderPending = (
	olderState: string | undefined,
	once: LocalSyncOnce,
	reread: () => void,
): Promise<void> => {
	if (olderState !== 'pending') return Promise.resolve()
	return once.run().then((ranOk) => {
		if (ranOk === true) reread()
	})
}
