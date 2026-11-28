/**
 * The recipient's pending delivery receipts. The sender's message stays "awaiting confirmation" until a receipt reaches it, and one send of a receipt does not show that it arrived.
 * Each receipt is therefore recorded BEFORE it is first sent, and sent again until one send succeeds.
 *
 * A send the entry answered as successful (today an empty 2xx body, which does not say the message was stored) proves nothing about the sender: when the sender's message ARRIVES AGAIN, its receipt is sent again,
 * done or not (redelivered), within the same pacing.
 *
 * One small document per receipt, keyed by account: `chat-rcptout-v1:<account>:<keyed tag of the sendId>`, sealed with the account's browser codec; it holds the sendId, the sender's address and the time, nothing
 * else. A receipt that was sent is MARKED done and is not sent again unless the message arrives again; the document is not removed (this class of document is outside what the page removes and outside the reset). Known limit: they accumulate;
 * cleaning them up is a separate change.
 *
 * Pacing: one send at a time, at least MIN_GAP_MS between any two sends, per receipt a growing wait that stays at the last (5 minutes) value; a kick (network back, page visible) never goes below those limits.
 * Account: only the owning account's page creates this, `alive()` is asked before every send, and dispose() (account change) stops everything.
 * Not covered: a send answered as successful that never reaches the sender is only repaired if the sender sends the message again (there is no acknowledgement of a receipt).
 */
import type { DraftCodec } from './chatDraftStore'
import type { QueueDocAdapter } from './sendQueue'
import { docTaggerFor, mayUseChatDocs, queueCodecFor } from './sendQueueCodec'

export const RECEIPT_OUTBOX_PREFIX = 'chat-rcptout-v1:'
export const RECEIPT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000]
export const RECEIPT_MIN_GAP_MS = 1_000

export interface ReceiptOutboxEntry { sendId: string; to: string; createdAt: number }
type Stored = ReceiptOutboxEntry & { v: 1; done?: true }

export interface ReceiptOutbox {
	/**
	 * Records the receipt as pending (a receipt already done is left done) and sends it as soon as the pacing allows. true: the record is on disk (pending or done). false: it could not be written (it is still
	 * sent from memory); the caller must then not acknowledge the message to the mailbox, and asks again. Calling it again is safe.
	 */
	add(sendId: string, to: string): Promise<boolean>
	/**
	 * The message of this receipt arrived AGAIN: the sender may still be waiting. A pending receipt is tried sooner; a done one becomes pending again (on disk) and is sent once more; one with no record is made
	 * only when the caller holds the stored message (`hasStoredRow`), so a protocol frame never gets a receipt. A record for another address is left alone. Never sooner than the first retry delay after the last send.
	 */
	redelivered(sendId: string, to: string, hasStoredRow: boolean): Promise<void>
	/** at start: every pending receipt of this account */
	load(): Promise<void>
	/** the network is back / the page is visible: try the pending ones sooner, within the pacing limits */
	kick(): void
	dispose(): void
}

/** A verified line that was handled before has arrived again. Only a message this account holds, or one a receipt is already recorded for, gets a receipt again (never a receipt or another protocol frame). */
export function noteRedeliveredLine(outbox: Pick<ReceiptOutbox, 'redelivered'> | null, signer: string, sendId: string | null, chats: ReadonlyArray<{ address?: unknown; messages?: ReadonlyArray<{ from?: unknown; sendId?: unknown }> }> | undefined): void {
	if (!outbox || !sendId || !signer) return
	const from = signer.trim().toLowerCase()
	const hasStoredRow = (chats ?? []).some((c) => String(c.address ?? '').toLowerCase() === from && (c.messages ?? []).some((m) => m.from !== 'me' && m.sendId === sendId))
	void outbox.redelivered(sendId, from, hasStoredRow)
}

export function createReceiptOutbox(input: {
	eoa: string
	privateKey: string | undefined | null
	nativeShell: boolean
	doc: QueueDocAdapter
	/** one attempt: true only when the receipt was posted and the post answered as successful; false for a failure or a skip */
	send: (entry: ReceiptOutboxEntry) => Promise<boolean>
	/** is the owning account still the current one */
	alive: () => boolean
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}): ReceiptOutbox | null {
	const tags = docTaggerFor(input.privateKey, input.eoa)
	if (!mayUseChatDocs(tags, input.nativeShell)) return null // a browser without its key writes nothing
	const codec: DraftCodec = queueCodecFor(input.privateKey)
	const prefix = `${RECEIPT_OUTBOX_PREFIX}${input.eoa.trim().toLowerCase()}:`
	const idOf = (sendId: string) => `${prefix}${tags.sendTag(sendId)}`
	const now = input.now ?? (() => Date.now())
	const setTimer = input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
	const clearTimer = input.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

	type Item = { entry: ReceiptOutboxEntry; attempts: number; lastAt: number; dueAt: number; onDisk: boolean; sending?: boolean; again?: boolean }
	const pending = new Map<string, Item>()
	let timer: unknown = null
	let running = false
	let lastSendAt = Number.NEGATIVE_INFINITY
	/** per receipt: when this page last sent it successfully (the pacing of a resend) */
	const sentAt = new Map<string, number>()
	let disposed = false

	const readStored = async (id: string): Promise<Stored | 'absent' | 'unreadable'> => {
		const raw = await input.doc.read(id)
		if (raw === null) return 'absent'
		const plain = await codec.decode(raw)
		if (plain === null) return 'unreadable'
		try {
			const v = JSON.parse(plain) as Stored
			return v && v.v === 1 && typeof v.sendId === 'string' && typeof v.to === 'string' && idOf(v.sendId) === id ? v : 'unreadable'
		} catch {
			return 'unreadable'
		}
	}
	const write = async (entry: ReceiptOutboxEntry, done: boolean): Promise<void> => {
		const stored: Stored = { v: 1, sendId: entry.sendId, to: entry.to, createdAt: entry.createdAt, ...(done ? { done: true as const } : {}) }
		await input.doc.put(idOf(entry.sendId), await codec.encode(JSON.stringify(stored)))
	}

	/** one timer for the earliest receipt that is due */
	const schedule = (): void => {
		if (timer !== null) { clearTimer(timer); timer = null }
		if (disposed || running || !pending.size) return
		const due = Math.min(...[...pending.values()].map((i) => i.dueAt))
		const at = Math.max(due, lastSendAt + RECEIPT_MIN_GAP_MS)
		timer = setTimer(() => { timer = null; void step() }, Math.max(0, at - now()))
	}
	const step = async (): Promise<void> => {
		if (disposed || running) return
		if (!input.alive()) return // another account is current: nothing is sent and nothing is scheduled (this outbox is about to be disposed)
		const t = now()
		const next = [...pending.entries()].filter(([, i]) => i.dueAt <= t).sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
		if (!next || t < lastSendAt + RECEIPT_MIN_GAP_MS) { schedule(); return }
		const [id, item] = next
		running = true
		lastSendAt = t
		item.lastAt = t
		let ok = false
		item.sending = true
		item.again = false
		try { ok = (await input.send(item.entry)) === true } catch { ok = false }
		item.sending = false
		if (ok && item.again) {
			// the message arrived again while this receipt was being posted: that arrival is not answered by this send (a successful answer proves nothing), so one more goes, paced
			sentAt.set(id, t)
			item.again = false
			item.attempts = 0
			item.dueAt = now() + (RECEIPT_RETRY_DELAYS_MS[0] as number)
		} else if (ok) {
			pending.delete(id)
			sentAt.set(id, t)
			// sent: marked, never removed. A mark that cannot be written means one more send after a restart (the sender ignores a repeated receipt).
			try { await write(item.entry, true) } catch { /* see above */ }
		} else {
			const delay = RECEIPT_RETRY_DELAYS_MS[Math.min(item.attempts, RECEIPT_RETRY_DELAYS_MS.length - 1)] as number
			item.attempts += 1
			item.dueAt = now() + delay
		}
		running = false
		schedule()
	}

	return {
		async add(sendId, to) {
			const id = idOf(sendId)
			if (disposed || !sendId || !to) return false
			const held = pending.get(id)
			if (held?.onDisk) return true
			const entry: ReceiptOutboxEntry = held?.entry ?? { sendId, to: to.trim().toLowerCase(), createdAt: now() }
			let stored: Stored | 'absent' | 'unreadable' = 'unreadable'
			let readOk = true
			try { stored = await readStored(id) } catch { readOk = false /* cannot tell: send it (a repeated receipt is harmless), do not overwrite */ }
			if (typeof stored === 'object' && stored.done) return true
			let onDisk = typeof stored === 'object'
			if (readOk && stored === 'absent') {
				try { await write(entry, false); onDisk = true } catch { /* kept in memory for this page; not on disk */ }
			}
			if (disposed) return onDisk
			const now_ = pending.get(id)
			if (now_) now_.onDisk = now_.onDisk || onDisk
			else pending.set(id, { entry: typeof stored === 'object' ? { sendId: stored.sendId, to: stored.to, createdAt: stored.createdAt } : entry, attempts: 0, lastAt: Number.NEGATIVE_INFINITY, dueAt: now(), onDisk })
			schedule()
			return onDisk
		},
		async redelivered(sendId, to, hasStoredRow) {
			if (disposed || !sendId || !to) return
			const id = idOf(sendId)
			const address = to.trim().toLowerCase()
			const sooner = (item: Item): void => { if (item.entry.to === address) { if (item.sending) item.again = true; item.dueAt = Math.min(item.dueAt, Math.max(now(), item.lastAt + (RECEIPT_RETRY_DELAYS_MS[0] as number))); schedule() } }
			const held = pending.get(id)
			if (held) { sooner(held); return }
			let stored: Stored | 'absent' | 'unreadable'
			try { stored = await readStored(id) } catch { return /* cannot tell what this is: the next arrival asks again */ }
			if (stored === 'unreadable') return
			if (stored === 'absent' ? !hasStoredRow : stored.to !== address) return
			const entry: ReceiptOutboxEntry = stored === 'absent' ? { sendId, to: address, createdAt: now() } : { sendId: stored.sendId, to: stored.to, createdAt: stored.createdAt }
			let onDisk = false
			try { await write(entry, false); onDisk = true } catch { /* sent from memory; the record on disk stays as it was */ }
			if (disposed) return
			const raced = pending.get(id)
			if (raced) { sooner(raced); return }
			const last = sentAt.get(id) ?? Number.NEGATIVE_INFINITY
			pending.set(id, { entry, attempts: 0, lastAt: last, dueAt: Math.max(now(), last + (RECEIPT_RETRY_DELAYS_MS[0] as number)), onDisk })
			schedule()
		},
		async load() {
			let ids: string[] = []
			try { ids = (await input.doc.list(prefix)).filter((id) => id.startsWith(prefix)) } catch { return }
			for (const id of ids) {
				let stored: Stored | 'absent' | 'unreadable' = 'unreadable'
				try { stored = await readStored(id) } catch { /* left as it is */ }
				if (typeof stored !== 'object' || stored.done || pending.has(id) || disposed) continue
				pending.set(id, { entry: { sendId: stored.sendId, to: stored.to, createdAt: stored.createdAt }, attempts: 0, lastAt: Number.NEGATIVE_INFINITY, dueAt: now(), onDisk: true })
			}
			schedule()
		},
		kick() {
			if (disposed) return
			// sooner, but never closer than the first retry delay to this receipt's own last attempt
			for (const item of pending.values()) item.dueAt = Math.min(item.dueAt, Math.max(now(), item.lastAt + (RECEIPT_RETRY_DELAYS_MS[0] as number)))
			schedule()
		},
		dispose() {
			disposed = true
			if (timer !== null) { clearTimer(timer); timer = null }
			pending.clear()
		},
	}
}
