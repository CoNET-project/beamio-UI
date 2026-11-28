/**
 * the recipient's delivery receipt as DURABLE evidence, for a queued message.
 *
 * The receipt bus (deliveryReceiptBus.ts) lives in the page's memory, and a receipt may be handled while its conversation is closed, or right before the page ends. In library mode the account record holds
 * no bodies, so a mark on the stored message is not enough either. So the receipt is written to a small document BEFORE the mailbox ACK of its line (commit, then ACK):
 *
 *   chat-receipt-v1:<eoa lower>:<peerTag>:<sendTag> { v, sendId, peer, at } (the same codec as the queue documents: AES-GCM in the browser, base64 JSON in the shells: NOT encryption there)
 *
 * The id carries keyed tags (sendQueueCodec.ts docTaggerFor), not the contact address and not the sendId; the real peer and sendId are in the sealed body and are checked against the key on every read.
 *
 * Rules:
 *  - written only for a sendId whose QUEUE DOCUMENT exists on disk (read from disk, not from memory slots), and only when the receipt's sender is the item's contact: nobody can fill the store with receipts for
 *    arbitrary sendIds. No body, no text: sendId, peer, the time it arrived.
 *  - a failed write holds THAT receipt's line only: the line is not ACKed, no dedupe marker is set for it, and it is put into the normal path again with a back-off (inboundBatchSettle.ts, receiptHold.ts).
 *  - read back with a check: the document's sendId, peer and key must agree and the sender must be the item's contact; the existence of a document alone is not evidence.
 *  - a queue document that EXISTS but cannot be read is "not known", never "absent": its receipt line is held, not ACKed, so the evidence is not lost behind an ACK. A reading that stays unreadable with the key known is promoted to permanent (see persistReceiptEvidence).
 *  - the cleaner decides from the RAW records: a receipt whose sendTag (from its key) still has a queue record on disk is never removed, whether or not either side can be decoded.
 *  - released in this order: the queue document first, then the receipt document (a kill in between leaves at most one orphan receipt document).
 *  - the queue reads the disk on every entry (a second tab, a restart), not only the event bus.
 *  - only ORPHANS are ever cleaned (no queue document any more): older than 7 days, or more than 2000, oldest first, lazily when the queue loads. A receipt whose queue document still exists is never removed by age or count.
 * Nothing here logs. The contact address and the sendId are written only into the sealed body (the id holds tags).
 */
import type { DraftCodec } from './chatDraftStore'
import type { QueueDocAdapter, QueueLookup } from './sendQueue'
import type { DocTagger } from './sendQueueCodec'
import { receiptHoldStats, type ReceiptHoldStats, type UnreadableTracker } from './receiptHold'

export const RECEIPT_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const RECEIPT_ORPHAN_MAX_COUNT = 2000

export interface ReceiptDoc { v: 1; sendId: string; peer: string; at: number }

const lower = (s: string): string => String(s || '').trim().toLowerCase()
export const receiptDocPrefix = (eoa: string): string => `chat-receipt-v1:${lower(eoa)}:`
export const receiptDocId = (eoa: string, tags: DocTagger, peer: string, sendId: string): string => `${receiptDocPrefix(eoa)}${tags.peerTag(peer)}:${tags.sendTag(sendId)}`
/** the sendTag in a receipt document id (the part after the contact tag); null when the id is not of the shape prefix:peerTag:sendTag */
export const sendTagOfReceiptDocId = (eoa: string, id: string): string | null => {
	const prefix = receiptDocPrefix(eoa)
	if (!id.startsWith(prefix)) return null
	const parts = id.slice(prefix.length).split(':')
	return parts.length === 2 && !!parts[0] && !!parts[1] ? parts[1] : null
}

const validDoc = (x: unknown): x is ReceiptDoc => {
	const d = x as ReceiptDoc
	return !!d && d.v === 1 && typeof d.sendId === 'string' && !!d.sendId && typeof d.peer === 'string' && !!d.peer && typeof d.at === 'number' && Number.isFinite(d.at)
}

export interface ReceiptStore {
	/** upsert the receipt of this sendId from this contact */
	put(peer: string, sendId: string, at?: number): Promise<void>
	/** the document, only when it is consistent (its sendId, peer and key agree); null otherwise */
	get(peer: string, sendId: string): Promise<ReceiptDoc | null>
	/** true only for a consistent document of exactly this contact and sendId */
	has(peer: string, sendId: string): Promise<boolean>
	remove(peer: string, sendId: string): Promise<void>
	/**
	 * removes the orphans (no queue record) older than the age limit, and the oldest ones beyond the count limit; a receipt whose queue record exists is never removed. `queueSendIds` lists the sendIds of the RAW queue
	 * records on disk (the ids only, nothing is decoded: a queue record that cannot be read still protects its receipt). When it throws, nothing is removed. Returns how many were removed.
	 */
	pruneOrphans(input: { queueSendIds: () => Promise<readonly string[]> }): Promise<number>
}

export function createReceiptStore(input: { eoa: string; doc: QueueDocAdapter; codec: DraftCodec; tags: DocTagger; now?: () => number }): ReceiptStore {
	const now = input.now ?? (() => Date.now())
	const prefix = receiptDocPrefix(input.eoa)
	const read = async (id: string): Promise<ReceiptDoc | null> => {
		const stored = await input.doc.read(id)
		if (stored === null) return null
		const plain = await input.codec.decode(stored)
		if (plain === null) return null
		try {
			const parsed = JSON.parse(plain) as { receipt?: unknown }
			return validDoc(parsed?.receipt) ? parsed.receipt : null
		} catch {
			return null
		}
	}
	const getConsistent = async (peer: string, sendId: string): Promise<ReceiptDoc | null> => {
		const id = receiptDocId(input.eoa, input.tags, peer, sendId)
		const d = await read(id)
		if (!d) return null
		// the content must agree with the key and with the contact asked for: a document under the wrong key, or for another contact / sendId, is not evidence (the id holds only tags: the sealed body names the real ones)
		if (d.sendId !== String(sendId).trim() || d.peer !== lower(peer) || receiptDocId(input.eoa, input.tags, d.peer, d.sendId) !== id) return null
		return d
	}
	return {
		put: async (peer, sendId, at) => {
			const doc: ReceiptDoc = { v: 1, sendId: String(sendId).trim(), peer: lower(peer), at: at ?? now() }
			await input.doc.put(receiptDocId(input.eoa, input.tags, peer, sendId), await input.codec.encode(JSON.stringify({ receipt: doc })))
		},
		get: getConsistent,
		has: async (peer, sendId) => {
			try {
				return (await getConsistent(peer, sendId)) !== null
			} catch {
				return false
			}
		},
		remove: async (peer, sendId) => {
			await input.doc.remove(receiptDocId(input.eoa, input.tags, peer, sendId))
		},
		pruneOrphans: async ({ queueSendIds }) => {
			// the raw queue records first: when they cannot be listed nothing is removed (a failure is never read as "no queue record")
			const queueTags = new Set((await queueSendIds()).map((sid) => input.tags.sendTag(sid)))
			const ids = (await input.doc.list(prefix)).filter((id) => id.startsWith(prefix))
			const orphans: Array<{ id: string; at: number }> = []
			for (const id of ids) {
				const keyTag = sendTagOfReceiptDocId(input.eoa, id)
				// its queue record is still there (readable or not): never removed by age or count. The sendTag comes from the KEY, so a receipt document that cannot be read is protected the same way.
				if (keyTag && queueTags.has(keyTag)) continue
				let d: ReceiptDoc | null
				try {
					d = await read(id)
				} catch {
					continue // the disk could not be read: neither its age nor its queue record is known, so it stays
				}
				// no queue record for this key; an unreadable, inconsistent or malformed document has no age: it counts as an orphan with the oldest possible age
				if (!d || !keyTag || receiptDocId(input.eoa, input.tags, d.peer, d.sendId) !== id) { orphans.push({ id, at: 0 }); continue }
				orphans.push({ id, at: d.at })
			}
			orphans.sort((a, b) => a.at - b.at)
			const t = now()
			let removed = 0
			const doomed = new Set<string>()
			for (const o of orphans) if (t - o.at > RECEIPT_ORPHAN_MAX_AGE_MS) doomed.add(o.id)
			const remaining = orphans.filter((o) => !doomed.has(o.id))
			for (let i = 0; i < remaining.length - RECEIPT_ORPHAN_MAX_COUNT; i++) doomed.add(remaining[i].id)
			for (const id of doomed) {
				try {
					await input.doc.remove(id)
					removed += 1
				} catch {
					/* stays; the next load tries again */
				}
			}
			return removed
		},
	}
}

/**
 * The batch step: write the receipt documents of this inbound batch, ROW BY ROW. Only for a sendId whose queue document is ON DISK (queueDoc reads the disk) and whose contact is the item's contact.
 * It does not decide for the whole batch any more: it returns which receipts are HELD (`held`), the caller keeps exactly their lines pending (no marker, no ACK) and settles the others.
 *  - no key yet (`canReadSealed` false: a browser whose key armor is not known): every receipt is held (reason no_key); nothing is read and nothing is written with the keyless tagger. Transient.
 *  - the queue lookup throws, or a write fails: held (disk_read_failed / write_failed).
 *  - the queue document exists but cannot be read: its line is HELD, always (unreadable_wait). A streak of three readings, or ten minutes, is counted as PERMANENT (UnreadableTracker, stats.permanent, the
 *    QA line) and changes nothing else: the product rule: the only exit from the queue is a receipt that binds the same message and a safely stored local copy, and a decryption failure is never a
 *    business success. So no receipt document is written for it and its line is never ACKed; it stays pending and is retried with the back-off (receiptHold.ts) while the other lines of the batch go on.
 *  - no queue document at all, or a receipt from another contact: nothing to keep, not held.
 */
export type ReceiptHoldReason = 'no_key' | 'unreadable_wait' | 'disk_read_failed' | 'write_failed'
export interface ReceiptInput { sendId: string; from: string; /** the mailbox line that carried it (the caller maps held receipts back to lines) */ line?: string }
export interface HeldReceipt extends ReceiptInput { reason: ReceiptHoldReason }
export interface ReceiptStepResult { held: HeldReceipt[]; written: number }

/**
 * The receipt step of a batch belongs to the account the batch was stored for. When another account is current by the time the step runs, its queue documents are not this batch's: nothing is looked up and
 * EVERY receipt line is held (not ACKed), so the mailbox of the owning account keeps it and delivers it again. `stillTheBatchAccount` is asked again after the step: a change during it holds everything as well.
 */
export async function persistBatchReceipts(input: { receiptLines: string[]; stillTheBatchAccount: () => boolean; step: () => Promise<{ heldLines: string[] }> }): Promise<{ heldLines: string[] }> {
	if (!input.stillTheBatchAccount()) return { heldLines: input.receiptLines }
	const result = await input.step()
	return input.stillTheBatchAccount() ? result : { heldLines: input.receiptLines }
}

export async function persistReceiptEvidence(input: {
	receipts: ReadonlyArray<ReceiptInput>
	/** the lookup of the queue document ON DISK (sendQueue.ts QueueStore.inspect): absent, readable item, or present but unreadable */
	queueDoc: (sendId: string) => Promise<QueueLookup>
	store: ReceiptStore
	/** false for a browser page without its key armor (mayUseChatDocs): nothing is read or written then. Default true. */
	canReadSealed?: boolean
	/** the streak of unreadable readings per sendId; without it an unreadable queue document is always held */
	unreadable?: UnreadableTracker
	stats?: ReceiptHoldStats
}): Promise<ReceiptStepResult> {
	const stats = input.stats ?? receiptHoldStats
	const result: ReceiptStepResult = { held: [], written: 0 }
	const hold = (r: ReceiptInput, reason: ReceiptHoldReason): void => {
		result.held.push({ ...r, reason })
		stats.held += 1
		if (reason === 'no_key') stats.heldNoKey += 1
		else if (reason === 'unreadable_wait') stats.heldUnreadable += 1
		else stats.heldDisk += 1
	}
	for (const r of input.receipts) {
		const sendId = String(r.sendId || '').trim()
		const from = lower(r.from)
		if (!sendId || !from) continue
		if (input.canReadSealed === false) { hold(r, 'no_key'); continue }
		let found: QueueLookup
		try {
			found = await input.queueDoc(sendId)
		} catch {
			hold(r, 'disk_read_failed') // the disk could not be read: the receipt is not stored and not acknowledged
			continue
		}
		if (found.kind === 'unreadable') {
			// present but unreadable is NOT "no document": the receipt cannot be bound to a contact here. The line is held; the streak only counts (a permanent one is never promoted into a write or an ACK)
			const streak = input.unreadable?.note(sendId)
			if (streak?.becamePermanent) stats.permanent += 1
			hold(r, 'unreadable_wait')
			continue
		}
		input.unreadable?.clear(sendId)
		if (found.kind === 'absent' || lower(found.item.peer) !== from) continue // no queue document on disk, or the receipt came from someone else: nothing to keep
		try {
			await input.store.put(from, sendId)
		} catch {
			hold(r, 'write_failed')
			continue
		}
		result.written += 1
	}
	if (input.unreadable) stats.permanentActive = input.unreadable.permanentCount()
	return result
}
