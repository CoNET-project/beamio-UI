/**
 * the draft and the pending record of a chat message, as a pure state machine (no storage, no timer).
 *
 *   draft(v) --click send, version v committed, input cleared--> pending(sendId) --record committed--> sending --answer--> sent --> delivered
 *   a write that fails: the draft stays a draft (the input is not cleared, nothing is sent); a request that fails: failed (retryable, same sendId);
 *   after a reload a pending / sending message is `unconfirmed`: it may or may not have reached the other side; sending it again does not duplicate (same sendId, the receiver de-duplicates).
 *
 * One record per conversation lives in the draft document (chatDraftStore.ts). `v` is a per-conversation version that only goes up; a write of an older version never replaces a newer one.
 * `sendId` is made when the draft is created and stays the same until the message is confirmed or dropped: the click does not make a new one.
 */
export type DraftPhase = 'draft' | 'pending'

export interface DraftQuote {
	id?: string
	text: string
	from: 'me' | 'them'
}

export interface DraftRecord {
	/** per-conversation version, only goes up */
	v: number
	sendId: string
	text: string
	quote?: DraftQuote
	createdAt: number
	updatedAt: number
	phase: DraftPhase
}

/** Per conversation (address, lower case): ONE draft, the text being typed. A message the user has clicked send on is not a draft: it lives in the send queue, per sendId (sendQueue.ts). */
export interface DraftEntry {
	draft?: DraftRecord
}
export type DraftBook = Record<string, DraftEntry>

/** The next version of the draft of a conversation. The sendId and the creation time are kept while the record is still a draft; after a pending record (or none) a new draft gets a new sendId. */
export function nextDraft(prev: DraftRecord | undefined, text: string, now: number, makeSendId: () => string, quote?: DraftQuote): DraftRecord {
	const keep = prev && prev.phase === 'draft'
	return {
		v: (prev?.v ?? 0) + 1,
		sendId: keep ? prev.sendId : makeSendId(),
		text,
		...(quote ? { quote } : keep && prev.quote ? { quote: prev.quote } : {}),
		createdAt: keep ? prev.createdAt : now,
		updatedAt: now,
		phase: 'draft',
	}
}

/** The click on send: the committed draft becomes the pending record (same sendId and text, a new version). */
export function toPending(rec: DraftRecord, now: number): DraftRecord {
	return { ...rec, v: rec.v + 1, updatedAt: now, phase: 'pending' }
}

/** True when `next` may replace what is stored: never an older version over a newer one. */
export function mayReplace(stored: DraftRecord | undefined, next: DraftRecord): boolean {
	return !stored || next.v > stored.v
}

export interface DraftRestore {
	/** the text to put back into the input box (a draft that was typed but never sent) */
	inputDraft?: DraftRecord
	/** a draft slot of a message that is already queued or already in the list (the release of the draft slot did not land): it is removed, it must not come back as input text */
	dropDraft?: DraftRecord
}

/**
 * What a reload does with the draft of a conversation. `knownSendIds` are the sendIds of the queue items and of the stored messages of that conversation: a draft with one of those sendIds is the
 * message that was clicked (its click was committed), not text still being typed.
 */
export function restoreDraft(entry: DraftEntry | undefined, knownSendIds: ReadonlySet<string>): DraftRestore {
	if (!entry?.draft) return {}
	if (knownSendIds.has(entry.draft.sendId)) return { dropDraft: entry.draft }
	return entry.draft.text.trim() ? { inputDraft: entry.draft } : {}
}

/** The message that an `unconfirmed` pending record becomes in the list: failed, retryable, the same sendId and time. */
export function unconfirmedMessage(rec: DraftRecord): {
	id: string
	sendId: string
	from: 'me'
	text: string
	createdAt: number
	status: 'failed'
	sendError: 'unconfirmed'
	quote?: DraftQuote
} {
	return {
		id: `tmp_${rec.createdAt}_${rec.sendId.slice(0, 8)}`,
		sendId: rec.sendId,
		from: 'me',
		text: rec.text,
		createdAt: rec.createdAt,
		status: 'failed',
		sendError: 'unconfirmed',
		...(rec.quote ? { quote: rec.quote } : {}),
	}
}
