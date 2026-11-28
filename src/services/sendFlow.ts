/**
 * the first steps of a send and the restore on mount, in one place so that chat.tsx and the tests run the same code.
 *
 *  1. beginSend: the text of the input becomes a queue item (sendQueue.ts, its own document per sendId) and is written AT ONCE (no timer). Only after it has landed is the input cleared
 *     and the send accepted; if it did not land the input keeps its text and nothing is sent (the caller shows "not saved, not sent").
 *  2. The sequence follows (outgoingSend.ts): the message is written to the account record, then, only then, the request goes out.
 *  3. The queue item is removed only when the receipt for it was seen AND the sent state is on disk (sendQueue.ts); until then it stays, and a reload / online / timer resumes it with the same sendId.
 *  restoreOnMount: what a reload puts back: a draft into the input (never sent automatically), a queued message that is not in the list into the list.
 */
import type { DraftAutosaver, DraftStore } from './chatDraftStore'
import { restoreDraft, unconfirmedMessage, type DraftBook, type DraftRecord } from './chatDraftState'
import type { AttemptResult, QueueItem, QueueStore, SendQueue } from './sendQueue'
import { noteRequestInFlight, noteRequestSettled } from './chatWriteLock'

export async function beginSend(input: {
	autosaver: DraftAutosaver
	/** the text of the input box at the click (the DOM value, so that a composition that has just ended is included) */
	currentText: string
	clearInput: () => void
	onNotSaved: (error: unknown) => void
}): Promise<{ ok: true; sendId: string; rec: DraftRecord } | { ok: false }> {
	input.autosaver.onInput(input.currentText)
	const committed = await input.autosaver.commitPending()
	if (!committed.ok) {
		input.onNotSaved(committed.error)
		return { ok: false }
	}
	input.clearInput()
	return { ok: true, sendId: committed.rec.sendId, rec: committed.rec }
}

/**
 * The ONLY way the text of the input is accepted as a message. With no draft saver or no send queue (a page whose account or key is not ready) nothing is accepted: the input keeps its text and nothing is
 * sent. A message that exists only in memory is lost by a reload.
 */
export async function acceptOutgoingText(input: {
	autosaver: DraftAutosaver | null
	queueReady: boolean
	currentText: string
	clearInput: () => void
	onNotSaved: (error: unknown) => void
}): Promise<{ ok: true; sendId: string; rec: DraftRecord } | { ok: false }> {
	if (!input.autosaver || !input.queueReady) {
		input.onNotSaved(new Error('send_queue_not_ready'))
		return { ok: false }
	}
	return beginSend({ autosaver: input.autosaver, currentText: input.currentText, clearInput: input.clearInput, onNotSaved: input.onNotSaved })
}

/** what stays in the input after a message was accepted: what was typed while its write was in flight is never cleared with it. null: leave the input exactly as it is (it was changed in another way) */
export const inputAfterAccept = (current: string, accepted: string): string | null => {
	if (current.trim() === accepted) return ''
	const from = current.indexOf(accepted)
	return from >= 0 && !current.slice(0, from).trim() ? current.slice(from + accepted.length).replace(/^\s+/, '') : null
}

/** A file or voice message is ACCEPTED only when its payload is a queue item on disk. A queue that is not ready or an item that cannot be written: not accepted (the caller keeps its draft). */
export async function acceptQueuedWire(input: { queue: Pick<SendQueue, 'enqueue'> | null; peer: string; sendId: string; createdAt: number; wire: string; now?: () => number }): Promise<boolean> {
	const peer = input.peer.trim().toLowerCase()
	if (!input.queue || !peer) return false
	const item: QueueItem = { v: 1, sendId: input.sendId, peer, text: '', wire: input.wire, createdAt: input.createdAt, queuedAt: (input.now ?? Date.now)() }
	const landed = await input.queue.enqueue(item, { inline: true }).catch((error: unknown) => ({ ok: false as const, error }))
	return landed.ok
}

/** Delivery of an accepted item: the account record holds it before the request leaves; a record that cannot be written sends nothing. */
export async function deliverQueuedWire(input: { queue: Pick<SendQueue, 'run'>; sendId: string; persist: () => Promise<unknown>; onPersistFailed: () => void; deliver: () => Promise<AttemptResult> }): Promise<AttemptResult | 'skipped'> {
	return input.queue.run(input.sendId, async () => {
		try { await input.persist() } catch { input.onPersistFailed(); return { kind: 'failed' } }
		// like a text send: while the request is on its way, a reload the app asks for waits for its answer (also when the conversation has been left)
		noteRequestInFlight(input.sendId)
		try { return await input.deliver() } finally { noteRequestSettled(input.sendId) }
	}, { inline: true })
}

/** the queue of one conversation as read after a reload. A queue that cannot be read, or a record on disk that cannot be opened, is reported: it is never taken for an empty queue */
export async function loadQueueChecked(queue: Pick<SendQueue, 'load'>, store: Pick<QueueStore, 'list' | 'rawSendIds'>): Promise<{ items: QueueItem[]; problem: null | 'load_failed' | 'unreadable'; unreadable: number }> {
	let items: QueueItem[]
	try { items = await queue.load() } catch { return { items: [], problem: 'load_failed', unreadable: 0 } }
	try {
		const [raw, readable] = await Promise.all([store.rawSendIds(), store.list()])
		const opened = new Set(readable.map((i) => i.sendId))
		const unreadable = raw.filter((id) => !opened.has(id)).length
		return { items, problem: unreadable ? 'unreadable' : null, unreadable }
	} catch {
		return { items, problem: 'load_failed', unreadable: 0 }
	}
}

/** the list fields of a stored file / voice / payment card payload; {} for a text item or a payload that cannot be read */
/** the restore's read of the queue: the problem is handed to the page's notice in the same step, so it cannot be read and not shown */
export async function readConversationQueue(queue: Pick<SendQueue, 'load'>, store: Pick<QueueStore, 'list' | 'rawSendIds'>, showProblem: (problem: null | 'load_failed' | 'unreadable') => void, stillMounted: () => boolean): Promise<QueueItem[]> {
	let loaded = await loadQueueChecked(queue, store)
	// the listing and the read are two steps: an item added or removed between them is not a damaged record. A reported problem is read again before it is shown.
	if (loaded.problem) loaded = await loadQueueChecked(queue, store)
	if (stillMounted()) showProblem(loaded.problem)
	return loaded.items
}

const fieldsOfWire = (wire: string | undefined): Record<string, unknown> => {
	if (!wire) return {}
	try {
		const p = JSON.parse(wire) as Record<string, unknown>
		return { ...(p.fileMessage ? { fileMessage: p.fileMessage } : {}), ...(p.voiceMessage ? { voiceMessage: p.voiceMessage } : {}), ...(p.paymentCard ? { paymentCard: p.paymentCard } : {}) }
	} catch {
		return {}
	}
}

export const queueItemFromDraft = (rec: DraftRecord, peer: string, now: number): QueueItem => ({
	v: 1,
	sendId: rec.sendId,
	peer: peer.trim().toLowerCase(),
	text: rec.text,
	...(rec.quote ? { quote: rec.quote } : {}),
	createdAt: rec.createdAt,
	queuedAt: now,
})

export interface MountRestore {
	inputText?: string
	seed?: DraftRecord
	/** a draft slot of a message that is already queued / listed: remove it */
	dropDraftSendId?: string
}

/** The draft of the conversation. `queueItems` and `stored` tell which sendIds are messages already (a draft with such a sendId is the clicked message, not text being typed). */
export async function restoreOnMount(input: { store: DraftStore; peer: string; queueItems: readonly QueueItem[]; stored: readonly { sendId?: string }[] }): Promise<MountRestore> {
	let book: DraftBook = {}
	try {
		book = await input.store.load()
	} catch {
		return {}
	}
	const known = new Set<string>()
	for (const i of input.queueItems) known.add(i.sendId)
	for (const m of input.stored) if (m.sendId) known.add(m.sendId)
	const r = restoreDraft(book[input.peer.trim().toLowerCase()], known)
	const out: MountRestore = {}
	if (r.inputDraft) {
		out.inputText = r.inputDraft.text
		out.seed = r.inputDraft
	}
	if (r.dropDraft) out.dropDraftSendId = r.dropDraft.sendId
	return out
}

/** The queued messages that are not in the stored list yet (the account record write did not land before the page died): they come back into the list as messages that are being resumed. */
export function messagesForUnlisted(items: readonly QueueItem[], stored: readonly { sendId?: string }[]): Array<ReturnType<typeof unconfirmedMessage>> {
	const listed = new Set(stored.map((m) => m.sendId).filter(Boolean) as string[])
	return items
		.filter((i) => !listed.has(i.sendId))
		.map((i) => ({ ...unconfirmedMessage({ v: 0, sendId: i.sendId, text: i.text, createdAt: i.createdAt, updatedAt: i.queuedAt, phase: 'pending', ...(i.quote ? { quote: i.quote } : {}) }), ...fieldsOfWire(i.wire) }))
}
