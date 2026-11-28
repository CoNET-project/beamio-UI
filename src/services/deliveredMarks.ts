/**
 * the "delivered" state of the sender's own messages, kept in the page's own small documents when the conversation is served from the local library.
 *
 * Problem: in library mode the account record keeps no message bodies, the library entry of a sent message is written once with status `sent`
 * (`history.append` has no revision, so a later append of the same sendId does not update it), and the receipt documents are removed when the queue item is released. After a reload the bubble that was
 * Delivered shows Sent again. The SDK is not changed (that would be an SDK release); the page keeps what it knows:
 *
 *   chat-delivered-v1:<eoa lower>:<peerTag>:<sendTag> { v, sendId, peer, at } (the codec of the queue and receipt documents: AES-GCM in the browser, base64 JSON in the shells: NOT encryption)
 *
 * The id carries keyed tags (sendQueueCodec.ts docTaggerFor), not the contact address and not the sendId; the real ones are in the sealed body and are checked against the key on every read. The documents of one
 * contact still share the deterministic prefix `<eoa>:<peerTag>:`.
 *
 * Rules:
 *  - written in the SAME step in which the message is marked delivered, before the queue item is released and before the receipt document is deleted; a failed write keeps both (the evidence stays, the next
 *    entry writes again). Only in library mode (the sender's copy is judged by the library): outside it the account record already holds `delivered`.
 *  - used only as a ONE-WAY upgrade when the conversation's messages are merged with the library's, by the total order of messageStatusOrder.ts: a status BELOW `delivered` (sending, failed, held, sent) becomes
 *    `delivered`; `delivered` and `read` are never touched; only for the same sendId in the same contact's conversation (the marks are loaded per contact), only for the sender's own messages. A document that cannot
 *    be read, or whose content disagrees with its key, counts as absent and never raises a state.
 *  - only in a client that holds the sender's copy in the library (chat.tsx markDeliveredDurable): a shell has no library and never writes these documents.
 *  - kept by RECENCY, not by age (an old message must not fall back to Sent): the newest 500 per contact and the newest 5000 in all (DELIVERED_PER_PEER_MAX, DELIVERED_GLOBAL_MAX), cleaned lazily when the
 *    conversation loads; the counts come from the document ids, the documents are read (to order them by time) only for a contact or an account over its limit.
 *  - content: sendId, peer, the time. No text. Nothing here logs.
 */
import type { DraftCodec } from './chatDraftStore'
import { messageStatusRank } from './messageStatusOrder'
import type { QueueDocAdapter } from './sendQueue'
import type { DocTagger } from './sendQueueCodec'

export const DELIVERED_PER_PEER_MAX = 500
export const DELIVERED_GLOBAL_MAX = 5000

export interface DeliveredDoc { v: 1; sendId: string; peer: string; at: number }

const lower = (s: string): string => String(s || '').trim().toLowerCase()
export const deliveredDocPrefix = (eoa: string): string => `chat-delivered-v1:${lower(eoa)}:`
export const deliveredPeerPrefix = (eoa: string, tags: DocTagger, peer: string): string => `${deliveredDocPrefix(eoa)}${tags.peerTag(peer)}:`
export const deliveredDocId = (eoa: string, tags: DocTagger, peer: string, sendId: string): string => `${deliveredPeerPrefix(eoa, tags, peer)}${tags.sendTag(sendId)}`

const validDoc = (x: unknown): x is DeliveredDoc => {
	const d = x as DeliveredDoc
	return !!d && d.v === 1 && typeof d.sendId === 'string' && !!d.sendId && typeof d.peer === 'string' && !!d.peer && typeof d.at === 'number' && Number.isFinite(d.at)
}

export interface DeliveredStore {
	/** records that the message with this sendId of this contact was delivered (an upsert of its own document) */
	put(peer: string, sendId: string, at?: number): Promise<void>
	/** the sendIds of this contact that have a consistent document; an unreadable or inconsistent document is absent */
	loadFor(peer: string): Promise<Set<string>>
	/** keeps the newest `perPeerMax` per contact and the newest `globalMax` in all; returns how many documents were removed */
	prune(limits?: { perPeerMax?: number; globalMax?: number }): Promise<number>
}

export function createDeliveredStore(input: { eoa: string; doc: QueueDocAdapter; codec: DraftCodec; tags: DocTagger; now?: () => number }): DeliveredStore {
	const now = input.now ?? (() => Date.now())
	const prefix = deliveredDocPrefix(input.eoa)
	const read = async (id: string): Promise<DeliveredDoc | null> => {
		const stored = await input.doc.read(id)
		if (stored === null) return null
		const plain = await input.codec.decode(stored)
		if (plain === null) return null
		try {
			const parsed = JSON.parse(plain) as { delivered?: unknown }
			return validDoc(parsed?.delivered) ? parsed.delivered : null
		} catch {
			return null
		}
	}
	const consistent = (id: string, d: DeliveredDoc | null): d is DeliveredDoc => !!d && deliveredDocId(input.eoa, input.tags, d.peer, d.sendId) === id
	return {
		put: async (peer, sendId, at) => {
			const doc: DeliveredDoc = { v: 1, sendId: String(sendId).trim(), peer: lower(peer), at: at ?? now() }
			await input.doc.put(deliveredDocId(input.eoa, input.tags, peer, sendId), await input.codec.encode(JSON.stringify({ delivered: doc })))
		},
		loadFor: async (peer) => {
			const pp = deliveredPeerPrefix(input.eoa, input.tags, peer)
			const out = new Set<string>()
			let ids: string[]
			try {
				ids = (await input.doc.list(pp)).filter((id) => id.startsWith(pp))
			} catch {
				return out
			}
			for (const id of ids) {
				try {
					const d = await read(id)
					// the content must agree with its key and with the contact: otherwise it is absent and raises nothing
					if (consistent(id, d) && d.peer === lower(peer)) out.add(d.sendId)
				} catch {
					/* unreadable: absent */
				}
			}
			return out
		},
		prune: async (limits) => {
			const perPeerMax = limits?.perPeerMax ?? DELIVERED_PER_PEER_MAX
			const globalMax = limits?.globalMax ?? DELIVERED_GLOBAL_MAX
			const ids = (await input.doc.list(prefix)).filter((id) => id.startsWith(prefix))
			// the contact of a document is in its id: no read is needed to count
			const byPeer = new Map<string, string[]>()
			for (const id of ids) {
				const rest = id.slice(prefix.length)
				const peer = rest.slice(0, rest.indexOf(':'))
				const list = byPeer.get(peer) ?? []
				list.push(id)
				byPeer.set(peer, list)
			}
			const overPeer = [...byPeer.values()].some((l) => l.length > perPeerMax)
			if (!overPeer && ids.length <= globalMax) return 0
			// over a limit: read the documents of the contacts that are over (or all, when the account is over) to order them by time
			const needRead = overPeer || ids.length > globalMax ? ids : []
			const rows: Array<{ id: string; peer: string; at: number }> = []
			for (const id of needRead) {
				const rest = id.slice(prefix.length)
				const peer = rest.slice(0, rest.indexOf(':'))
				let at = 0 // unreadable: counts as the oldest, goes first
				try {
					const d = await read(id)
					if (consistent(id, d)) at = d.at
				} catch {
					/* oldest */
				}
				rows.push({ id, peer, at })
			}
			const doomed = new Set<string>()
			const perPeer = new Map<string, Array<{ id: string; at: number }>>()
			for (const r of rows) {
				const l = perPeer.get(r.peer) ?? []
				l.push(r)
				perPeer.set(r.peer, l)
			}
			for (const l of perPeer.values()) {
				l.sort((a, b) => a.at - b.at)
				for (let i = 0; i < l.length - perPeerMax; i++) doomed.add(l[i].id)
			}
			const kept = rows.filter((r) => !doomed.has(r.id)).sort((a, b) => a.at - b.at)
			for (let i = 0; i < kept.length - globalMax; i++) doomed.add(kept[i].id)
			let removed = 0
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
 * The one-way upgrade by the total order of the message status (messageStatusOrder.ts): a message of the sender's own whose sendId is in `marks` and whose status ranks BELOW `delivered` (sending, failed, route_unconfirmed,
 * first_fetch_pending, fingerprint_changed, sent) becomes `delivered` (a send error that a failed copy carried is cleared: the recipient has the message). `delivered` and `read` are never changed, so nothing is ever lowered.
 * Another person's message and a sendId that is not in the set are untouched. Returns the same array when nothing changes.
 */
const DELIVERED_RANK = messageStatusRank('delivered')
export function applyDeliveredMarks<T extends { from?: string; sendId?: string; status?: string; sendError?: unknown }>(messages: T[], marks: ReadonlySet<string>): T[] {
	if (!marks.size || !messages.length) return messages
	let changed = false
	const out = messages.map((m) => {
		if (m.from === 'me' && typeof m.sendId === 'string' && marks.has(m.sendId) && messageStatusRank(m.status) < DELIVERED_RANK) {
			changed = true
			return { ...m, status: 'delivered', sendError: undefined }
		}
		return m
	})
	return changed ? out : messages
}
