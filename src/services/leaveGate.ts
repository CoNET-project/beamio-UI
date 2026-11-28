/**
 * May the user leave the chat page (or may the app reload / change its address)? The owner's rule: only when BOTH are empty for the current wallet, and nothing else is a condition.
 *  - unsent: every send that is still in flight outside the queue (being sealed, uploaded, written; a draft whose acceptance failed and that is only in memory) and EVERY item still in the queue. An item
 *    leaves the queue only on a valid receipt for its own sendId (sendReceiptPolicy.ts: the recipient's delivery receipt, or a receipt bound to this item's inner armor); reading is not waited for. An empty
 *    2xx answer, a receipt of another message, an error or an invalid answer leave the item in the queue, and so leave it unsent. What kind of answer was stored with an item decides nothing here.
 *  - unarchived: every message that must be in the history and whose batch is not yet BOTH pinned AND named by a pointer that was accepted. A pin without the pointer does not clear it.
 * A source that cannot be read (not read yet, a failed or undecodable read, an unknown wallet, no way to know) is 'unknown', and unknown blocks like pending. There is no timeout and no override here.
 * PURE: it reads nothing itself, writes nothing, sends nothing and must never ask for a batch to be written early.
 */
export type SourceReading = { read: true; count: number } | { read: false; why: string }
export interface LeaveSources {
	wallet: string
	/** sends of this wallet that are not a queue item (pendingSends.ts) */
	inFlight: SourceReading
	/** the queue items of this wallet, every conversation: all of them are unsent until they leave the queue */
	queue: { read: true; items: ReadonlyArray<unknown>; unreadable: number } | { read: false; why: string }
	/** messages not yet archived (pinned batch AND accepted pointer) */
	unarchived: SourceReading
}
export type LeaveState =
	| { state: 'clear' }
	| { state: 'pending'; unsent: number; unarchived: number }
	| { state: 'unknown'; reasons: string[] }

export function leaveStateOf(sources: LeaveSources): LeaveState {
	const reasons: string[] = []
	if (!/^0x[0-9a-fA-F]{40}$/.test(sources.wallet)) reasons.push('wallet_unknown')
	for (const [name, source] of [['in_flight', sources.inFlight], ['queue', sources.queue], ['archive', sources.unarchived]] as const) if (!source.read) reasons.push(`${name}:${source.why}`)
	const unsent = (sources.inFlight.read ? sources.inFlight.count : 0) + (sources.queue.read ? sources.queue.items.length + sources.queue.unreadable : 0)
	const unarchived = sources.unarchived.read ? sources.unarchived.count : 0
	if (reasons.length) return { state: 'unknown', reasons }
	return unsent || unarchived ? { state: 'pending', unsent, unarchived } : { state: 'clear' }
}
export const leaveBlocked = (state: LeaveState): boolean => state.state !== 'clear'
