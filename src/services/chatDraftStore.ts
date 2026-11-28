/**
 * where the draft is written, and how often. (A message the user has clicked send on is not a draft: it goes to the send queue, sendQueue.ts, one document per sendId.)
 *
 * Storage: the page's own PouchDB database (conet), a small document `chat-draft-v1:<eoa>` of its own. It is NOT the account document (`init`): that one is read, merged and rewritten as a whole on
 * every write, which is too heavy for a keystroke. The adapter (beamio.ts) writes through the same durable helper as the other documents and respects the page write gate.
 *
 * Protection, said plainly:
 *  - browser: the content is AES-GCM sealed with the same scheme as the local file-message copy (fileMessageCipher): key = keccak256(private key), 12-byte random IV, "iv.cipher" in base64.
 *  - shell (iOS/Android): the page holds no private key, so the content is stored like the sent messages already are: base64 JSON. That is NOT encryption. The same protection as the stored messages,
 *    no more.
 * There is no localStorage and no other plaintext copy anywhere in this feature.
 *
 * Autosave: a trailing throttle (the autosave rate, not a way to hide a refresh window) and one write in flight at a time. The click on send never waits for the timer: commitPending cancels it and
 * writes at once. A write of an older version never replaces a newer one.
 */
import { mayReplace, nextDraft, toPending, type DraftBook, type DraftEntry, type DraftQuote, type DraftRecord } from './chatDraftState'

export interface DraftDocAdapter {
	/** the stored text of the document, or null when it is missing. Throws when it cannot be read. */
	read(docId: string): Promise<string | null>
	/** writes the document and resolves only when it has landed. Throws when the page write gate refused it or the write failed. */
	put(docId: string, text: string): Promise<void>
	remove(docId: string): Promise<void>
}

export interface DraftCodec {
	/** 'aes-gcm' is sealed; 'base64-json' is NOT encryption (see the file header) */
	readonly kind: 'aes-gcm' | 'base64-json'
	encode(plain: string): Promise<string>
	/** null when the text cannot be read (wrong key, damaged) */
	decode(text: string): Promise<string | null>
}

export const draftDocId = (eoa: string): string => `chat-draft-v1:${String(eoa || '').trim().toLowerCase()}`

const toBase64 = (bytes: Uint8Array): string => {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(binary)
}
const fromBase64 = (value: string): Uint8Array => {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/** Shell: the same protection as the stored messages (base64 JSON). NOT encryption. */
export function base64JsonCodec(): DraftCodec {
	return {
		kind: 'base64-json',
		encode: async (plain) => toBase64(new TextEncoder().encode(plain)),
		decode: async (text) => {
			try {
				return new TextDecoder().decode(fromBase64(text))
			} catch {
				return null
			}
		},
	}
}

/** Browser: AES-GCM with the key of the local file-message copy (keccak256 of the private key). `keyBytes` is that 32-byte value, made by the caller (chat.tsx). */
export function aesGcmCodec(keyBytes: Uint8Array): DraftCodec {
	const key = (usage: KeyUsage[]) => crypto.subtle.importKey('raw', keyBytes as unknown as BufferSource, 'AES-GCM', false, usage)
	return {
		kind: 'aes-gcm',
		encode: async (plain) => {
			const iv = crypto.getRandomValues(new Uint8Array(12))
			const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(['encrypt']), new TextEncoder().encode(plain)))
			return `${toBase64(iv)}.${toBase64(cipher)}`
		},
		decode: async (text) => {
			try {
				const [ivB64, cipherB64] = text.split('.')
				if (!ivB64 || !cipherB64) return null
				const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) as unknown as BufferSource }, await key(['decrypt']), fromBase64(cipherB64) as unknown as BufferSource)
				return new TextDecoder().decode(plain)
			} catch {
				return null
			}
		},
	}
}

export interface DraftStore {
	load(): Promise<DraftBook>
	/** writes one slot of a conversation (an older version never replaces a newer one). Rejects when the write did not land. */
	saveSlot(peer: string, slot: 'draft', rec: DraftRecord): Promise<void>
	removeSlot(peer: string, slot: 'draft', sendId?: string): Promise<void>
}

/** Reads and writes the book document. Writes run one after the other (the book is read, changed and written back as a whole; it is small). */
export function createDraftStore(input: { eoa: string; doc: DraftDocAdapter; codec: DraftCodec }): DraftStore {
	const id = draftDocId(input.eoa)
	let tail: Promise<unknown> = Promise.resolve()
	const serial = <T,>(task: () => Promise<T>): Promise<T> => {
		const run = tail.catch(() => undefined).then(task)
		tail = run
		return run
	}
	const readBook = async (): Promise<DraftBook> => {
		const text = await input.doc.read(id)
		if (text === null) return {}
		const plain = await input.codec.decode(text)
		if (plain === null) return {}
		try {
			const parsed = JSON.parse(plain) as { book?: DraftBook }
			return parsed && typeof parsed === 'object' && parsed.book && typeof parsed.book === 'object' ? parsed.book : {}
		} catch {
			return {}
		}
	}
	const writeBook = async (book: DraftBook): Promise<void> => {
		const empty = Object.values(book).every((e) => !e.draft)
		if (empty) {
			await input.doc.remove(id)
			return
		}
		await input.doc.put(id, await input.codec.encode(JSON.stringify({ book })))
	}
	return {
		load: () => serial(readBook),
		saveSlot: (peer, slot, rec) =>
			serial(async () => {
				const key = peer.trim().toLowerCase()
				const book = await readBook()
				const entry: DraftEntry = { ...(book[key] ?? {}) }
				if (!mayReplace(entry[slot], rec)) return
				entry[slot] = rec
				book[key] = entry
				await writeBook(book)
			}),
		removeSlot: (peer, slot, sendId) =>
			serial(async () => {
				const key = peer.trim().toLowerCase()
				const book = await readBook()
				const entry = book[key]
				if (!entry || !entry[slot]) return
				if (sendId && entry[slot]!.sendId !== sendId) return
				const next: DraftEntry = { ...entry }
				delete next[slot]
				if (!next.draft) delete book[key]
				else book[key] = next
				await writeBook(book)
			}),
	}
}

export type CommitResult = { ok: true; rec: DraftRecord } | { ok: false; error: unknown }

export interface DraftAutosaver {
	/** The text of the input changed (not while an IME composition is open). */
	onInput(text: string, quote?: DraftQuote): void
	/** Writes the latest version at once (blur, hidden, pagehide). Resolves when it has landed or failed. */
	flushNow(): Promise<CommitResult | null>
	/** The click on send: the latest draft becomes a queue item and is written at once (no timer). Resolves when it has landed; only then may the input be cleared. */
	commitPending(): Promise<CommitResult>
	/** The latest draft record in memory (for the tests and the restore). */
	latest(): DraftRecord | undefined
	/** Seeds the autosaver with a draft read back after a reload (so versions go on from the stored one). */
	seed(rec: DraftRecord | undefined): void
}

export function createDraftAutosaver(opts: {
	store: DraftStore
	peer: string
	/** writes the clicked message into the send queue (an upsert of its own document); resolves ok only when it has landed */
	enqueue: (rec: DraftRecord) => Promise<{ ok: true } | { ok: false; error: unknown }>
	makeSendId?: () => string
	now?: () => number
	throttleMs?: number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (h: unknown) => void
	/** the draft has changes that are not written yet / all changes are written (the controlled reload waits while dirty) */
	onDirty?: () => void
	onSaved?: () => void
}): DraftAutosaver {
	const makeSendId = opts.makeSendId ?? (() => crypto.randomUUID())
	const now = opts.now ?? (() => Date.now())
	const throttleMs = opts.throttleMs ?? 200
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
	const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
	let current: DraftRecord | undefined
	let committedV = 0
	let timer: unknown = null
	let chain: Promise<unknown> = Promise.resolve()

	const commitDraft = (): Promise<CommitResult | null> => {
		const rec = current
		if (!rec || rec.v <= committedV) return Promise.resolve(rec ? { ok: true, rec } : null)
		const run = chain
			.catch(() => undefined)
			.then(async (): Promise<CommitResult> => {
				// the newest version is written, not the one that was current when this write was asked for
				const latest = current as DraftRecord
				try {
					await opts.store.saveSlot(opts.peer, 'draft', latest)
					committedV = Math.max(committedV, latest.v)
					if (current && current.v === committedV) opts.onSaved?.()
					return { ok: true, rec: latest }
				} catch (error) {
					return { ok: false, error }
				}
			})
		chain = run
		return run
	}

	return {
		seed(rec) {
			current = rec
			committedV = rec?.v ?? 0
		},
		latest: () => current,
		onInput(text, quote) {
			if (current && current.phase === 'draft' && current.text === text) return
			// an empty box after a send (or before anything was typed) is not a new draft
			if (!text && (!current || current.phase === 'pending')) return
			// a draft that has no stored version yet (the first thing typed, or the first after a send) is written at once on its first keystroke, not after the throttle: the window in which typed text
			// has no stored copy at all is one write long instead of throttle + write. Later keystrokes are throttled (trailing).
			const leading = !current || current.phase === 'pending'
			// after a pending record the next thing typed is a new message (new sendId) with a higher version
			current = nextDraft(current, text, now(), makeSendId, quote)
			opts.onDirty?.()
			if (leading) void commitDraft()
			if (timer === null) {
				timer = setTimer(() => {
					timer = null
					void commitDraft()
				}, throttleMs)
			}
		},
		flushNow() {
			if (timer !== null) {
				clearTimer(timer)
				timer = null
			}
			return commitDraft()
		},
		async commitPending(): Promise<CommitResult> {
			if (timer !== null) {
				clearTimer(timer)
				timer = null
			}
			const base = current
			if (!base || base.phase !== 'draft' || !base.text.trim()) return { ok: false, error: new Error('draft_empty') }
			const pending = toPending(base, now())
			// from the click until the queue item has landed the conversation holds back a reload the app asks for (the write is in progress)
			opts.onDirty?.()
			// the click is written at once as a queue item (sendQueue.ts; its own document per sendId): no timer, and it does not wait for a draft write that may still be in flight
			let result: CommitResult
			try {
				const r = await opts.enqueue(pending)
				result = r.ok ? { ok: true, rec: pending } : { ok: false, error: r.error }
			} catch (error) {
				result = { ok: false, error }
			}
			// a failed write: the input keeps its text; the draft stays dirty (held) unless its latest version is on disk already
			if (!result.ok && current && current.v <= committedV) opts.onSaved?.()
			if (result.ok) {
				// the version goes on (a later draft is a new message with a new sendId and a higher version); the draft slot of this message is released
				current = pending
				committedV = pending.v
				// the release of the draft slot is NOT waited for: the input is cleared and the send goes on as soon as the queue item has landed. If this release does not land before a reload,
				// the restore sees a draft with the sendId of the queued message and drops it (chatDraftState.restoreDraft).
				void opts.store.removeSlot(opts.peer, 'draft', base.sendId).catch(() => undefined)
				opts.onSaved?.()
			}
			return result
		},
	}
}
