/**
 * merging chat rows of the account record WITHOUT replacing them from a snapshot.
 *
 * The case: two writers (the inbound batch in App.tsx addNewMessage and the conversation's storageData in chat.tsx) each hold their own snapshot of `profiles[0].chats`. The write lock is a counter
 * that defers refreshes and reloads; it does not order the two. So neither may put a whole snapshot over the record.
 *
 * The rule now: a writer never writes its snapshot. At the moment of writing it takes the CURRENT record (CoNET_Data, mutated synchronously by every writer, so it is the newest copy in memory) and merges
 * only what it changed into it:
 *  - messages: the union by message key (sendId, else id) of the current row and the writer's row; a message in both keeps the HIGHER status (messageStatusOrder.ts), the other fields of the winner;
 *  - the other row fields: only those the writer actually changed (compared with its own start snapshot); the rest stays as the current record has it;
 *  - receipts: applied to the CURRENT chats of the receipt's sender, not to the snapshot (a snapshot that does not contain the message cannot lose the mark);
 *  - rows the writer created are added, rows it did not touch stay exactly as they are now.
 * Pure: no storage, no timers.
 */
import { higherStatus, messageStatusRank } from './messageStatusOrder'

type Loose = Record<string, unknown>
const isObject = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v)
const addrOf = (row: unknown): string => (isObject(row) && typeof row.address === 'string' ? row.address.trim().toLowerCase() : '')
export const messageKeyOf = (m: unknown): string => {
	if (!isObject(m)) return ''
	// the direction is part of the key: a received row that carries the sendId of one of the user's own messages is another message. Without it the two were merged into one and the received copy
	// (its direction and its claimed status) could take the place of the user's own.
	if (typeof m.sendId === 'string' && m.sendId) return `s:${m.from === 'me' ? 'me' : 'them'}:${m.sendId}`
	if (typeof m.id === 'string' && m.id) return `i:${m.id}`
	return ''
}
const createdOf = (m: unknown): number => (isObject(m) && typeof m.createdAt === 'number' ? m.createdAt : 0)
const sameJson = (a: unknown, b: unknown): boolean => {
	try {
		return JSON.stringify(a) === JSON.stringify(b)
	} catch {
		return false
	}
}

/** One message present in both copies: the higher status wins; a tie goes to `preferred`. */
export function mergeOneMessage(current: unknown, incoming: unknown, preferIncomingOnTie: boolean): unknown {
	if (!isObject(current) || !isObject(incoming)) return incoming
	const rc = messageStatusRank(current.status)
	const ri = messageStatusRank(incoming.status)
	let out: Loose
	if (ri > rc) out = { ...current, ...incoming }
	else if (ri < rc) out = { ...incoming, ...current } // the current copy is further along: its status and its error stay
	else out = preferIncomingOnTie ? { ...current, ...incoming } : { ...incoming, ...current }
	// a persisted copy carries the encrypted manifest and NOT the plaintext one: a merge never brings the plaintext back from the other copy
	if ('fileMessageCipher' in incoming && !('fileMessage' in incoming)) delete out.fileMessage
	return out
}

/**
 * Tombstones: the sendIds of the messages the user removed on purpose (row.removedSendIds). A union cannot express a deletion: without them a removed message comes back from whichever copy still holds
 * it (the current row, a stale snapshot, the stored record). Every merge drops the messages named here, and the set itself only grows (a union; bounded to the newest MAX_TOMBSTONES).
 */
export const MAX_TOMBSTONES = 500
export function tombstonesOf(...rows: unknown[]): string[] {
	const set = new Set<string>()
	for (const r of rows) if (isObject(r) && Array.isArray(r.removedSendIds)) for (const id of r.removedSendIds) if (typeof id === 'string' && id) set.add(id)
	const all = [...set]
	return all.length > MAX_TOMBSTONES ? all.slice(all.length - MAX_TOMBSTONES) : all
}
const isDead = (m: unknown, dead: ReadonlySet<string>): boolean => isObject(m) && typeof m.sendId === 'string' && m.sendId !== '' && dead.has(m.sendId)
/** The row with its tombstones unioned in and the removed messages dropped. */
export function applyTombstones(row: Loose, dead: string[]): Loose {
	if (!dead.length) return row
	const set = new Set(dead)
	const out: Loose = { ...row, removedSendIds: dead }
	if (Array.isArray(row.messages)) out.messages = (row.messages as unknown[]).filter((m) => !isDead(m, set))
	return out
}

/** The messages of a row: the union by message key; a message in both takes the higher status. Ordered by createdAt (stable). `incomingWinsTies`: the second list is the newer writer. */
export function mergeMessagesMonotonic(current: unknown[], incoming: unknown[], incomingWinsTies = true): unknown[] {
	const out: unknown[] = []
	const index = new Map<string, number>()
	const put = (m: unknown, isIncoming: boolean): void => {
		const k = messageKeyOf(m)
		if (!k) {
			if (!out.some((o) => sameJson(o, m))) out.push(m)
			return
		}
		const at = index.get(k)
		if (at === undefined) {
			index.set(k, out.length)
			out.push(m)
		} else out[at] = isIncoming ? mergeOneMessage(out[at], m, incomingWinsTies) : out[at]
	}
	for (const m of current) put(m, false)
	for (const m of incoming) put(m, true)
	return out
		.map((m, i) => ({ m, i }))
		.sort((a, b) => createdOf(a.m) - createdOf(b.m) || a.i - b.i)
		.map((x) => x.m)
}

/**
 * The conversation writes its own row (its messages come from its own list). The current row stays the base: its messages are kept (an inbound message that the batch added while the conversation held an
 * older list is not dropped); the own messages are merged in with the higher status; the other fields are the writer's, as before.
 */
export function mergeOwnRowIntoCurrent(currentRow: unknown, ownRow: Loose): Loose {
	if (!isObject(currentRow)) return ownRow
	const merged: Loose = { ...currentRow, ...ownRow }
	const cm = Array.isArray(currentRow.messages) ? currentRow.messages : []
	const om = Array.isArray(ownRow.messages) ? ownRow.messages : []
	merged.messages = mergeMessagesMonotonic(cm, om, true)
	if (isObject(currentRow.chatData) || isObject(ownRow.chatData)) merged.chatData = { ...(isObject(currentRow.chatData) ? currentRow.chatData : {}), ...(isObject(ownRow.chatData) ? ownRow.chatData : {}) }
	return applyTombstones(merged, tombstonesOf(currentRow, ownRow))
}

/** Marks the messages of the user with this sendId delivered, only in the chat of `fromAddress` (the receipt's sender), never lowering a status. Returns the same array when nothing changes. */
export function markDeliveredFrom<T extends Loose>(chats: T[], sendId: string, fromAddress: string): { chats: T[]; updated: boolean } {
	const id = String(sendId || '').trim()
	const from = String(fromAddress || '').trim().toLowerCase()
	if (!id || !from || !Array.isArray(chats)) return { chats, updated: false }
	let updated = false
	const next = chats.map((chat) => {
		if (addrOf(chat) !== from || !Array.isArray(chat.messages)) return chat
		let touched = false
		const messages = (chat.messages as unknown[]).map((m) => {
			if (!isObject(m) || m.from !== 'me') return m
			if ((typeof m.sendId === 'string' && m.sendId ? m.sendId : m.id) !== id) return m
			if (messageStatusRank(m.status) >= messageStatusRank('delivered')) return m
			touched = true
			updated = true
			return { ...m, status: 'delivered' }
		})
		return touched ? ({ ...chat, messages } as T) : chat
	})
	return { chats: updated ? next : chats, updated }
}

export type BatchMergeInput = {
	/** the CURRENT chats (CoNET_Data now) */
	currentChats: Loose[]
	/** the batch's own start snapshot of the chats and its final chats */
	startChats: Loose[]
	batchChats: Loose[]
	/** the receipts of the batch: sendId + the sender's address */
	delivered: Array<{ sendId: string; from: string }>
}

/** What an inbound batch writes: only its changes, merged into the current chats. */
export function mergeBatchIntoCurrent(input: BatchMergeInput): Loose[] {
	const startBy = new Map<string, Loose>()
	for (const r of input.startChats) startBy.set(addrOf(r), r)
	let chats = [...input.currentChats]
	const fresh: Loose[] = []
	for (const row of input.batchChats) {
		const a = addrOf(row)
		const start = startBy.get(a)
		if (start && start === row) continue // untouched by the batch: stays as it is now
		const at = a ? chats.findIndex((c) => addrOf(c) === a) : -1
		if (at < 0) {
			fresh.push(row) // a conversation the batch created
			continue
		}
		const current = chats[at]
		const merged: Loose = { ...current }
		for (const k of Object.keys(row)) {
			if (k === 'messages') continue
			if (!start || !Object.is(row[k], start[k])) merged[k] = k === 'chatData' && isObject(current.chatData) && isObject(row[k]) ? { ...(current.chatData as Loose), ...(row[k] as Loose) } : row[k]
		}
		const cm = Array.isArray(current.messages) ? current.messages : []
		const bm = Array.isArray(row.messages) ? row.messages : []
		merged.messages = mergeMessagesMonotonic(cm, bm, true)
		// the batch's row is built from its (older) snapshot: a message the user removed since is not brought back by it
		chats[at] = applyTombstones(merged, tombstonesOf(current, row))
	}
	// the batch's new conversations go first, in the order the batch put them (unshift)
	chats = [...fresh, ...chats]
	for (const d of input.delivered) chats = markDeliveredFrom(chats, d.sendId, d.from).chats
	return chats
}

/** Phone call rows: the current rows plus the batch's changes (the batch's row wins for the same session). */
export function mergePhoneCalls(current: unknown, start: unknown, batch: unknown): unknown {
	if (batch === start) return current
	const key = (r: unknown): string => (isObject(r) ? String(r.sessionId ?? r.callId ?? '') : '')
	const cur = Array.isArray(current) ? current : []
	const out = [...cur]
	for (const r of Array.isArray(batch) ? batch : []) {
		const k = key(r)
		const at = k ? out.findIndex((o) => key(o) === k) : -1
		if (at >= 0) out[at] = r
		else out.push(r)
	}
	return out
}

/**
 * The record a writer must merge into: the CURRENT one. `currentGlobal` is CoNET_Data (mutated synchronously by every writer, so the newest copy in memory); `snapshot` is whatever profiles array the
 * writer holds (older). The current record is used when it is the same account (same non-empty keyID); otherwise the snapshot. Every write site goes through this one function, so that a site that
 * silently falls back to its snapshot is a one-line difference that a test can see (draftWiring.static.test.ts).
 */
export function pickCurrentProfiles<P extends { keyID?: unknown }>(currentGlobal: { profiles?: P[] } | null | undefined, snapshot: P[]): { profiles: P[]; isCurrent: boolean } {
	const cur = currentGlobal?.profiles
	const a = String(cur?.[0]?.keyID ?? '').toLowerCase()
	const b = String(snapshot?.[0]?.keyID ?? '').toLowerCase()
	return Array.isArray(cur) && cur.length > 0 && a !== '' && a === b ? { profiles: cur, isCurrent: true } : { profiles: snapshot, isCurrent: false }
}

export { higherStatus }
