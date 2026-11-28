/**
 * how the result of one delivery attempt is mapped for the send queue, and which stored messages the automatic resume may touch. Pure, so that the in-conversation runner of today and
 * an application-level runner use exactly the same rules.
 *
 * the product rule: after a network loss, a power-off or a reopen, a message the user clicked send on is picked up again BY ITSELF.
 *  - `route_unconfirmed` (the contact's key / route could not be read: a network-class failure) is a RETRYABLE failure. The message keeps showing "Route not confirmed" with Retry and Send anyway,
 *    and the queue tries again (back-off, online, page visible, reopen). Every automatic attempt reads the route again and passes the trust gate (sendWithFreshRoute): it never uses a cached route.
 *  - `fingerprint_changed` and `first_fetch_pending` are TRUST holds (the key has not been verified, or it changed): the user decides. They are never sent automatically.
 */
import type { AttemptResult } from './sendQueue'
import type { SendReceipt } from './sendAnswer'
import { decideReceipt } from './sendReceiptPolicy'

/** The codes that need the user (trust decisions). Nothing sends a message in these states by itself. */
export const USER_HELD_CODES: ReadonlySet<string> = new Set(['fingerprint_changed', 'first_fetch_pending'])

export const isUserHeldCode = (code: string | undefined | null): boolean => !!code && USER_HELD_CODES.has(code)

/** The queue result of a send that did not go out. */
export function mapDeliverFailure(failCode: string | undefined | null): AttemptResult {
	return isUserHeldCode(failCode) ? { kind: 'held' } : { kind: 'failed' }
}

/**
 * The status a message takes when its POST has been answered. It never goes BACK: if the recipient's delivery receipt arrived first (a fast recipient, or a slow answer to the POST), the message
 * is already `delivered` and stays so; writing `sent` over it lost the one positive proof and left the item in the queue for good.
 */
export const statusAfterPostAnswered = (current: string | undefined): 'sent' | 'delivered' => (current === 'delivered' ? 'delivered' : 'sent')

/** A stored message that is held for the user (its status or its error is a trust hold). */
export function isUserHeldMessage(m: { status?: string; sendError?: unknown }): boolean {
	return isUserHeldCode(m.status) || isUserHeldCode(typeof m.sendError === 'string' ? m.sendError : undefined)
}

/**
 * what the automatic resume does with a stored message of the user's own whose queue item survived (a reload, a kill, a reopen).
 *  - `trust_hold`: the key was not verified / changed. The user decides; nothing sends it.
 *  - `live_node_wait`: THIS page started a wait for the entry nodes (shell, chat start not finished) and that wait settles the item. A wait lives in the page's memory only: after a kill the new page has none,
 *    so a stored message is never in it and falls to `retry`.
 *  - `retry`: everything else (a `sending` message of an old page, failed, route_unconfirmed, identity_not_ready, interrupted): the same attempt as the Retry button, same sendId.
 */
export type ResumeClass = 'trust_hold' | 'live_node_wait' | 'retry'
/** the queue result of a resume that does not send: a trust hold waits for the user (held); a live wait for the entry nodes is `waiting` (ticked, not a hold) */
export const resumeResultOf = (c: Exclude<ResumeClass, 'retry'>): AttemptResult => (c === 'trust_hold' ? { kind: 'held' } : { kind: 'waiting' })

/**
 * what the queue does with the item after a HELD retry (retryHeldSend: the route ladder and the Retry / send-anyway buttons). One pure function, table-tested, so the release rule has behavioural
 * evidence and not only a static check:
 *  - the send failed: the failure mapping (a trust hold stays held for the user; route_unconfirmed and the rest are retryable `failed`);
 *  - the entry answered ok WITHOUT a bound receipt (an empty 200): `awaiting`, never released: it is not proof;
 *  - ok with a bound receipt for this sendId: `sent`, and `persisted` is whether the sender's copy is safe where the next load reads it (`ackCopy`: the record write outside library mode, the library ACK in it);
 *    the item leaves only when that is true, otherwise it stays `confirmed` and only the persistence is retried.
 * `ackCopy` is asked only for a bound receipt (an awaiting item must not start a library ACK it does not need yet).
 */
export async function heldSettleOf(input: { ok: boolean; code?: string | null; receipt: SendReceipt | null; persisted: boolean; ackCopy: (persisted: boolean) => Promise<boolean> }): Promise<AttemptResult> {
	if (!input.ok) return mapDeliverFailure(input.code)
	if (decideReceipt(input.receipt) === 'confirmed') return { kind: 'sent', persisted: await input.ackCopy(input.persisted) }
	return { kind: 'awaiting', persisted: input.persisted }
}

/**
 * the first decision of the automatic resume of a queue item: is there positive evidence (the recipient's delivery receipt) for THIS sendId, in memory or on disk? Then the evidence is applied,
 * whatever the chat crypto or the list say: applying needs neither, and the release inside it needs only two things (the message is in the list and its delivered state persisted; otherwise the item stays
 * `confirmed`, never resent). Only without evidence do the two early returns apply.
 */
export type ResumeEntry = 'apply_evidence' | 'chat_not_ready' | 'message_not_in_list' | 'continue'
export function resumeEntryOf(input: { evidenceInMemory: boolean; evidenceOnDisk: boolean; chatReady: boolean; messageInList: boolean }): ResumeEntry {
	if (input.evidenceInMemory || input.evidenceOnDisk) return 'apply_evidence'
	if (!input.chatReady) return 'chat_not_ready'
	if (!input.messageInList) return 'message_not_in_list'
	return 'continue'
}
export function resumeClassOf(m: { status?: string; sendError?: unknown }, page: { waitingForNodes: boolean }): ResumeClass {
	if (isUserHeldMessage(m)) return 'trust_hold'
	if (page.waitingForNodes) return 'live_node_wait'
	return 'retry'
}
