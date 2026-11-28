/**
 * "Failed · Tap to retry". A failed TEXT bubble is sent again from its original text through the full new-send path (a new recipient lookup, a new chain id check, a new
 * encryption); the bubble stays and goes back to "sending". A file or voice bubble is sent again from the payload stored with its queue item. Anything that cannot be sent again as it is
 * (calls, payments, replies, a message with no sendId) is KEPT: a tap never removes a bubble and never turns it back into input text (leaving the page would lose it there).
 */
import { heldWireFromMessage, type StoredTextMessage } from './heldWire'

export type FailedRetryPlan = { kind: 'resend'; wire: string } | { kind: 'keep' }

/** What a tap on a failed bubble does. Only a failed message of the user's own that can be rebuilt as a text wire is resent. */
export function failedRetryPlan(m: StoredTextMessage & { status?: string }): FailedRetryPlan {
	// a message whose contact route could not be read (route_unconfirmed) is a retryable failure too: the resend reads the route again
	if (m.status !== 'failed' && m.status !== 'route_unconfirmed') return { kind: 'keep' }
	const wire = heldWireFromMessage(m)
	return wire === null ? { kind: 'keep' } : { kind: 'resend', wire }
}

/**
 * The same with the payload stored with the queue item. A file or voice message is sent again from that payload (same sendId, same payload). Without it (not read yet, or unreadable) it is kept as
 * it is. A text message follows failedRetryPlan.
 */
export function bubbleRetryPlan(m: StoredTextMessage & { status?: string; fileMessage?: unknown; voiceMessage?: unknown }, storedWire: string | undefined): FailedRetryPlan {
	if (storedWire !== undefined) return { kind: 'resend', wire: storedWire }
	if (m.fileMessage || m.voiceMessage) return { kind: 'keep' }
	return failedRetryPlan(m)
}

/**
 * What the page does with a tap on a failed bubble, whatever its kind. The queue item of the message is never touched here except to run its attempt under its own claim: its sendId, payload and stored armor stay.
 * With no attempt (the message cannot be sent again from here) the user is told; nothing is removed, dropped or put into the input box.
 */
export async function tapFailedBubble<R>(input: {
	sendId: string | undefined
	attempt: (() => Promise<R>) | null
	queue: { has(sendId: string): boolean; run(sendId: string, attempt: () => Promise<R>): Promise<R | 'skipped'> } | null
	tellKept: () => void
}): Promise<R | 'skipped' | void> {
	if (!input.attempt) { input.tellKept(); return }
	// one attempt per sendId at a time (the same claim as the automatic resume): a tap during an automatic attempt, or in another tab, does not send twice
	if (input.queue && input.sendId && input.queue.has(input.sendId)) return input.queue.run(input.sendId, input.attempt)
	return input.attempt()
}

/** the retry handler every own bubble gives its status mark (text, file and voice alike) */
export const retryTapFor = <M extends { status?: string }>(m: M, retry: (m: M) => unknown): (() => void) => () => {
	if (m.status !== 'failed') return
	void retry(m)
}

type WithId = { id?: string }

/** The list with the message back in the sending state (no error); every other message is the same object. */
export function markSendingById<T extends WithId & { status?: string; sendError?: unknown; sendAttemptAt?: number }>(list: T[] | undefined, id: string, attemptAt: number = Date.now()): T[] {
	return (list ?? []).map((m) => (m.id === id ? { ...m, status: 'sending', sendError: undefined, sendAttemptAt: attemptAt } : m))
}

/** The list without the message. The caller writes the result to the page state AND to the stored copy (messagesRef, chatData.messages, storageData). */
export function removeMessageById<T extends WithId>(list: T[] | undefined, id: string): T[] {
	return (list ?? []).filter((m) => m.id !== id)
}


/**
 * a text message is stored in the `sending` state before it goes out (so a refresh in the middle of the send keeps it). A `sending` message that was made before this page load
 * has no send in flight any more (the page that was sending it is gone): it is shown as failed ("Tap to retry"), and the retry resends the same text with the same sendId (the
 * receiver de-duplicates by sendId). A message made in this page load is a live send and is never touched. The same list is returned when nothing changes.
 */
export function settleStaleSending<T extends { status?: string; createdAt?: number; sendAttemptAt?: number; sendError?: unknown }>(list: T[] | undefined, pageStartMs: number): T[] {
	const src = list ?? []
	let changed = false
	const out = src.map((m) => {
		if (m.status !== 'sending' || typeof m.createdAt !== 'number') return m
		// the latest send attempt decides (a retry made in this page load is a live send even though the message is older)
		const attemptAt = typeof m.sendAttemptAt === 'number' ? Math.max(m.createdAt, m.sendAttemptAt) : m.createdAt
		if (attemptAt >= pageStartMs) return m
		changed = true
		return { ...m, status: 'failed', sendError: 'interrupted' }
	})
	return changed ? out : src
}
