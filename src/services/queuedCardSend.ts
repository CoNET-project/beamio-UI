/**
 * Chat messages that are sent from OUTSIDE a conversation page (a gift with its note), through the same steps as a send of the page:
 *   1. every message is ACCEPTED first: its queue item (its own document, with the exact payload) is on disk; what cannot be written is neither shown nor sent;
 *   2. then it is shown, as `sending`;
 *   3. for each: the account record holds it (a durable write), then the request goes out with the item's stored inner armor; the answer is stored with the item;
 *   4. a failed attempt is shown as failed, never as sent; the item stays in the queue with the same sendId and payload. The conversation page resumes and retries it like any other item.
 * The item leaves the queue only on a valid receipt for its sendId, and then only once the sent state and the history copy are on disk. The whole call is counted as unsent from its start to its end.
 * Nothing here logs or returns any part of a message.
 */
import { createSendQueue, type AttemptResult, type QueueItem, type QueueStore, type SendQueueOptions } from './sendQueue'
import { decideReceipt } from './sendReceiptPolicy'
import { whilePending } from './pendingSends'
import { noteRequestInFlight, noteRequestSettled } from './chatWriteLock'
import type { SendArmorContext, SendReceipt } from './sendAnswer'

export interface CardSendEntry<M> {
	sendId: string
	createdAt: number
	/** the exact payload that goes out */
	payload: string
	/** a plain text message: its text (its payload is rebuilt from the stored message after a reload). '' otherwise: the payload itself is kept with the item. */
	text: string
	message: M
}

export interface CardSendDeps<M> {
	wallet: string
	peer: string
	store: QueueStore
	claim?: SendQueueOptions['claim']
	now?: () => number
	/** adds the accepted messages to the conversation */
	show: (messages: M[]) => void
	setStatus: (sendId: string, status: 'sending' | 'sent' | 'failed', sendError?: string) => void
	/** the account record is on disk when this resolves; it rejects when it did not land */
	persist: () => Promise<void>
	transmit: (payload: string, armor: SendArmorContext | undefined, onReceipt: (receipt: SendReceipt) => void) => Promise<boolean>
	/** the history append of a sent message; true only when it is confirmed */
	archive: (message: M) => Promise<boolean>
}

export interface CardSendResult { accepted: string[]; notAccepted: string[]; sent: string[]; failed: string[] }

export function sendQueuedCards<M extends object>(entries: ReadonlyArray<CardSendEntry<M>>, deps: CardSendDeps<M>): Promise<CardSendResult> {
	return whilePending(deps.wallet, 'card', async () => {
		const result: CardSendResult = { accepted: [], notAccepted: [], sent: [], failed: [] }
		const peer = deps.peer.trim().toLowerCase()
		const queue = createSendQueue({ store: deps.store, peer, claim: deps.claim, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => false, heartbeatMs: 0, retryDelaysMs: [] })
		try {
			const accepted: CardSendEntry<M>[] = []
			for (const entry of entries) {
				const item: QueueItem = { v: 1, sendId: entry.sendId, peer, text: entry.text, ...(entry.text ? {} : { wire: entry.payload }), createdAt: entry.createdAt, queuedAt: (deps.now ?? Date.now)() }
				const landed = await queue.enqueue(item, { inline: true }).catch((error: unknown) => ({ ok: false as const, error }))
				if (landed.ok) { accepted.push(entry); result.accepted.push(entry.sendId) } else result.notAccepted.push(entry.sendId)
			}
			if (!accepted.length) return result
			deps.show(accepted.map((e) => ({ ...e.message, status: 'sending' })))
			for (const entry of accepted) {
				let posted = false
				await queue.run(entry.sendId, async (): Promise<AttemptResult> => {
					try { await deps.persist() } catch { deps.setStatus(entry.sendId, 'failed', 'persist_failed'); return { kind: 'failed' } }
					noteRequestInFlight(entry.sendId)
					try {
						let receipt = null as SendReceipt | null
						let ok = false
						try { ok = await deps.transmit(entry.payload, await queue.armorContext(entry.sendId), (r) => { receipt = r }) } catch { ok = false }
						if (!ok) {
							deps.setStatus(entry.sendId, 'failed', 'send_failed')
							await deps.persist().catch(() => undefined)
							return { kind: 'failed' }
						}
						posted = true
						if (receipt) await queue.recordReceipt(entry.sendId, receipt.kind).catch(() => undefined)
						deps.setStatus(entry.sendId, 'sent')
						const recorded = await deps.persist().then(() => true, () => false)
						const copy = { ...entry.message, status: 'sent' }
						if (decideReceipt(receipt) !== 'confirmed') {
							// the item stays and still holds the message: the history append may finish behind it
							void deps.archive(copy).catch(() => false)
							return { kind: 'awaiting', persisted: recorded }
						}
						const archived = await deps.archive(copy).catch(() => false)
						return { kind: 'sent', persisted: recorded && archived }
					} finally {
						noteRequestSettled(entry.sendId)
					}
				}, { inline: true })
				;(posted ? result.sent : result.failed).push(entry.sendId)
			}
			return result
		} finally {
			queue.dispose()
		}
	})
}
