/**
 * Hand-off of a pending set (decision follow-up, 2026-11-22, item 1). A set whose first pwaWalletSync was not confirmed
 * (sync_pending) is given to the app's existing background sync mechanism (V2 tests; the schedule; completion only on the shell's
 * read-back). This module adds no retry of its own: it only calls the handler the app registers. Without a handler the call reports false
 * and nothing is retried here. The cipher carries no passcode.
 */
export type SyncPendingHandler = (cipher: Record<string, unknown>, eoa: string) => void

let handler: SyncPendingHandler | null = null

/** Registered by the app's sync mechanism (the page gate). null removes it. */
export function setSyncPendingHandler(h: SyncPendingHandler | null): void {
	handler = h
}

/** Gives one pending cipher to the registered mechanism. Returns false when none is registered (nothing was sent). */
export function handOffSyncPending(cipher: Record<string, unknown>, eoa: string): boolean {
	if (!handler) return false
	handler(cipher, eoa)
	return true
}
