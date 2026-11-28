/**
 * the total order of the status of a message the user sent. A merge of two copies of the same message (the stored copy, a snapshot, the writer's own copy) keeps the HIGHER status:
 * a stale copy can never take a message back (delivered -> sent, sent -> sending).
 *
 *   (none) 0 < sending 1 < failed / route_unconfirmed / first_fetch_pending / fingerprint_changed 2 < sent 3 < delivered 4 < read 5
 *
 * A failed or held message is above `sending`: the attempt ended, nothing is in flight. `sent` (the entry accepted the POST) is above the failures: a later failed re-POST of an already accepted message does
 * not make it unsent. The queue's own states (awaiting, held ...) are not message statuses and are not in this order.
 * Where the status is written (all of them end at the merge in chatsFloor.mergeMessages, which every persisted write passes): chat.tsx send / markSendingById (sending), deliverTextInner (sent, failed,
 * held statuses), markSendPersistFailed (failed), retryHeldSend, applyDeliveryReceipt and App.tsx markDeliveredFrom (delivered), persistConfirmed (sent), chat.ts makeMessage (inbound `sent`).
 */
const RANK: Record<string, number> = {
	sending: 1,
	failed: 2,
	route_unconfirmed: 2,
	first_fetch_pending: 2,
	fingerprint_changed: 2,
	sent: 3,
	delivered: 4,
	read: 5,
}

export const messageStatusRank = (status: unknown): number => (typeof status === 'string' ? RANK[status] ?? 0 : 0)

/** The status that survives a merge of two copies (the first one wins a tie). */
export const higherStatus = (a: unknown, b: unknown): unknown => (messageStatusRank(b) > messageStatusRank(a) ? b : a)

/** True when `next` would take a message back from `prev`. */
export const isStatusDowngrade = (prev: unknown, next: unknown): boolean => messageStatusRank(next) < messageStatusRank(prev)
