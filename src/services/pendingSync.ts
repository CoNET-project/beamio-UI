/**
 * C1 pendingSync (v10 §五): a held automatic sync. In memory only, no secret, no phrase: the resume re-reads the page's valid
 * mnemonic when it runs. Taken once: a take clears it, so the unlock resumes it exactly once.
 */
let pending: { reason: string } | null = null

export function markPendingSync(reason: string): void {
	pending = { reason }
}

/** Returns the held item and clears it; null when none. */
export function takePendingSync(): { reason: string } | null {
	const held = pending
	pending = null
	return held
}

export function hasPendingSync(): boolean {
	return pending !== null
}
