/**
 * Sends of this page that are not (yet) a queue item: a file or voice message being encrypted, uploaded or written, a group message on its way. Wallet level, outside every component: leaving or unmounting a
 * conversation changes nothing here. A token is taken synchronously at the click and ended when the queue item takes over, when the send ends, or when the user discards the draft it stands for.
 */
export type PendingKind = 'media' | 'voice' | 'group' | 'card'
const tokens = new Map<string, { wallet: string; kind: PendingKind }>()
const listeners = new Set<() => void>()
let sequence = 0
const changed = (): void => { for (const l of [...listeners]) { try { l() } catch { /* a listener decides nothing */ } } }

export function beginPending(wallet: string, kind: PendingKind): string {
	const token = `${kind}:${++sequence}`
	tokens.set(token, { wallet: wallet.trim().toLowerCase(), kind })
	changed()
	return token
}
export function endPending(token: string | null | undefined): void {
	if (token && tokens.delete(token)) changed()
}
export function pendingCountOf(wallet: string): number {
	const want = wallet.trim().toLowerCase()
	let n = 0
	for (const t of tokens.values()) if (t.wallet === want) n += 1
	return n
}
export function subscribePending(listener: () => void): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}
/** holders of drafts that a token stands for (mediaDraftHolder.ts) drop them together with the tokens */
const clearHooks = new Set<() => void>()
export const onClearAllPendingSends = (hook: () => void): void => { clearHooks.add(hook) }
/** a send that is counted from its start to its end, however it ends */
export async function whilePending<T>(wallet: string, kind: PendingKind, run: () => Promise<T>): Promise<T> {
	const token = beginPending(wallet, kind)
	try { return await run() } finally { endPending(token) }
}
/** only for the reload that follows the confirmed local reset (chatWriteLock.ts) */
export function clearAllPendingSends(): void {
	for (const hook of [...clearHooks]) hook()
	if (!tokens.size) return
	tokens.clear()
	changed()
}
export const resetPendingSendsForTest = (): void => { tokens.clear(); sequence = 0 }
