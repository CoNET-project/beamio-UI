/**
 * the durable send queue of chat messages the user has clicked "send" on.
 *
 * Storage (sendQueueStore): ONE small document PER sendId, `chat-queue-v1:<eoa>:<sendId>`, in the account database (never the account record `init`, never the draft document).
 * The key carries the account (EOA): another account's queue is never listed or read. A put is an upsert of that one document, a remove deletes that one document: two messages to the
 * same contact are two documents that live side by side; nothing ever replaces "the contact's latest message", and two tabs never overwrite each other's items.
 * Content: the item JSON through the codec of chatDraftStore.ts. Browser: AES-GCM under keccak256(private key). Shell: base64 JSON, the same protection as the messages already sent; it is NOT encryption.
 *
 * State machine (the persisted fact is only "the document exists"; the other states live in memory and are rebuilt after a restart, where every surviving item restarts as queued):
 *   queued the item is on disk, no attempt has started
 *   inflight an attempt is running (claimed: one attempt per sendId at a time)
 *   confirmed a receipt for THIS item was seen but the "sent" state is not on disk yet (only the persistence is retried, the message is NOT sent again)
 *   awaiting the POST was accepted by transport only (an empty 200, sendReceiptPolicy.ts): not proof; the same armor is posted again on the next triggers until a bound
 *               receipt or the recipient's delivery receipt arrives
 *   (removed) receipt seen AND the message + its sent state are on disk -> the document is deleted. Only now does the queue let go of the message
 *   failed the attempt ended with a clear failure (network, non-2xx, ok:false, route_unconfirmed): retried with the SAME sendId
 *   unknown the attempt threw / was cut off with no answer: retried with the SAME sendId (the mailbox keeps one copy and the recipient de-duplicates by sendId)
 *   held the send is held for the user because of a TRUST decision (fingerprint_changed, first_fetch_pending: the contact's key is not verified or changed): never retried automatically.
 *               route_unconfirmed (the route could not be read: network) is NOT held: it is a retryable failure, every automatic attempt reads the route again through the trust gate (sendResultMapping.ts)
 *
 * What lets an item leave (sendReceiptPolicy.ts, sendAnswer.ts): positive proof for THIS sendId only: a bound receipt (the mailbox answers {"ok":true,"stored"|"duplicate":true,"h":<keccak256 of the
 * inner armor, trimmed and cut after the END marker>} and h equals the digest the client stored for the item), or the recipient's delivery receipt for the sendId. An HTTP 2xx with an empty body is NOT
 * proof (it does not say the message was stored); neither are a body that could not be read, ok:false, store_failed, no_route, another digest or a body that is not ours. Without proof the item stays
 * (awaiting) and the stored inner armor is posted again with back-off; it is never encrypted a second time. The entry cannot read the sendId, so a receipt is bound to the item by the digest of the armor
 * that the item stores, not by a field with the sendId.
 *
 * Reload hold: while the queue holds an item the page's own reloads are suspended (chatWriteLock.setQueueDepth); the last removal releases them once.
 * Single flight: one attempt per sendId (memory), across tabs a Web Lock per sendId (claim), and the document is read again after the claim (a tab that lost the race finds it removed). That is the
 * sender side not sending twice; the recipient's de-duplication by sendId stays as the backstop and is not what this relies on.
 */
import type { DraftCodec, DraftDocAdapter } from './chatDraftStore'
import type { DraftQuote } from './chatDraftState'

export interface QueueItem {
	v: 1
	sendId: string
	peer: string
	text: string
	quote?: DraftQuote
	/** a message that is not rebuilt from text (a file, a voice message): the exact payload to send, kept with the item so that a reload can show it and send it again */
	wire?: string
	createdAt: number
	queuedAt: number
	/** the kind of acceptance answer this item's own POST got ('bound' is never replaced by the weaker one). Says nothing about whether the item may be released or is re-posted. */
	receipt?: 'bound' | 'legacy_empty'
	/** the inner armor of the first attempt and its keccak256, persisted BEFORE the first request: every retry of this sendId posts this armor, it never encrypts the message again */
	armor?: string
	armorDigest?: string
}

export type QueueState = 'queued' | 'inflight' | 'confirmed' | 'awaiting' | 'failed' | 'unknown' | 'held' | 'waiting'

/**
 * sent      positive proof for THIS sendId was seen (a bound receipt, or the recipient's delivery receipt): once `persisted`, the item leaves
 * awaiting  the POST was accepted by transport only (an empty 200): not proof, the item stays and the same armor is posted again later
 */
/**
 * waiting the page itself is waiting for the entry nodes (a shell whose chat start has not finished): NOT a hold for the user. It is ticked by the back-off and the heartbeat like a failure
 *          (the tick finds the page's own wait still live and does nothing), so it can never be stranded; the nodes arriving deliver it, the end of the wait settles it as failed.
 */
export type AttemptResult = { kind: 'sent'; persisted: boolean } | { kind: 'awaiting'; persisted: boolean } | { kind: 'failed' } | { kind: 'held' } | { kind: 'unknown' } | { kind: 'waiting' }

export interface QueueDocAdapter extends DraftDocAdapter {
	/** the ids of the documents whose id starts with `prefix` */
	list(prefix: string): Promise<string[]>
}

export const queueDocPrefix = (eoa: string): string => `chat-queue-v1:${String(eoa || '').trim().toLowerCase()}:`
export const queueDocId = (eoa: string, sendId: string): string => `${queueDocPrefix(eoa)}${sendId}`

/**
 * what the disk holds for one sendId. `get` answers null both for "no document" and for "a document that cannot be read" (wrong key, damaged, another codec): a caller that
 * decides something irreversible from that null (the receipt step ACKs the mailbox line on it) must use `inspect` and treat `unreadable` as "not known", never as "absent".
 */
export type QueueLookup = { kind: 'item'; item: QueueItem } | { kind: 'absent' } | { kind: 'unreadable' }

export interface QueueStore {
	put(item: QueueItem): Promise<void>
	get(sendId: string): Promise<QueueItem | null>
	/** the raw record is looked at first: no record is `absent`; a record that does not decode into an item of this sendId is `unreadable`. Throws when the disk cannot be read. */
	inspect(sendId: string): Promise<QueueLookup>
	remove(sendId: string): Promise<void>
	list(): Promise<QueueItem[]>
	/** the sendIds of the RAW queue records on disk, taken from the document ids; nothing is decoded, so a record that cannot be read still counts. Throws when the disk cannot be listed. */
	rawSendIds(): Promise<string[]>
}

const valid = (x: unknown): x is QueueItem => {
	const i = x as QueueItem
	return !!i && i.v === 1 && typeof i.sendId === 'string' && !!i.sendId && typeof i.peer === 'string' && !!i.peer && typeof i.text === 'string' && typeof i.createdAt === 'number'
}

export function createQueueStore(input: { eoa: string; doc: QueueDocAdapter; codec: DraftCodec }): QueueStore {
	const prefix = queueDocPrefix(input.eoa)
	const decode = async (stored: string | null): Promise<QueueItem | null> => {
		if (stored === null) return null
		const plain = await input.codec.decode(stored)
		if (plain === null) return null
		try {
			const parsed = JSON.parse(plain) as { item?: unknown }
			return valid(parsed?.item) ? parsed.item : null
		} catch {
			return null
		}
	}
	return {
		put: async (item) => {
			await input.doc.put(queueDocId(input.eoa, item.sendId), await input.codec.encode(JSON.stringify({ item })))
		},
		get: async (sendId) => decode(await input.doc.read(queueDocId(input.eoa, sendId))),
		inspect: async (sendId) => {
			const raw = await input.doc.read(queueDocId(input.eoa, sendId))
			if (raw === null) return { kind: 'absent' }
			const item = await decode(raw)
			// a record that decodes into an item of ANOTHER sendId is not this document either
			return item && item.sendId === sendId ? { kind: 'item', item } : { kind: 'unreadable' }
		},
		remove: async (sendId) => {
			await input.doc.remove(queueDocId(input.eoa, sendId))
		},
		rawSendIds: async () => (await input.doc.list(prefix)).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)),
		list: async () => {
			const ids = (await input.doc.list(prefix)).filter((id) => id.startsWith(prefix))
			const out: QueueItem[] = []
			for (const id of ids) {
				const item = await decode(await input.doc.read(id))
				// a document of another account (cannot happen with the prefix) or one that cannot be read is not an item of this queue
				if (item && queueDocId(input.eoa, item.sendId) === id) out.push(item)
			}
			return out.sort((a, b) => a.queuedAt - b.queuedAt || a.createdAt - b.createdAt)
		},
	}
}

/** One Web Lock per sendId (`ifAvailable`): another tab that is sending the same item makes this one skip. Without Web Locks (one page per account in the shells) the claim is always granted. */
export function webLocksClaim(eoa: string): (sendId: string) => Promise<null | (() => void)> {
	const name = (sendId: string) => `beamio-send-queue:${String(eoa || '').toLowerCase()}:${sendId}`
	return (sendId) =>
		new Promise((resolve) => {
			const locks = typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: { request: (n: string, o: unknown, cb: (lock: unknown) => unknown) => Promise<unknown> } }).locks : undefined
			if (!locks) {
				resolve(() => undefined)
				return
			}
			void locks
				.request(name(sendId), { ifAvailable: true }, (lock) => {
					if (!lock) {
						resolve(null)
						return undefined
					}
					return new Promise<void>((release) => resolve(() => release()))
				})
				.catch(() => resolve(() => undefined))
		})
}

export interface SendQueueOptions {
	store: QueueStore
	/** only the items of this conversation are held in memory and resumed here (the page that can send them) */
	peer: string
	/** one automatic attempt for an item after a reload / online / timer. Must return the outcome; it must never throw for an ordinary failure. */
	resume: (item: QueueItem) => Promise<AttemptResult>
	/** the receipt is seen, the sent state is not on disk: write it again. true when it landed. */
	persistConfirmed: (item: QueueItem) => Promise<boolean>
	claim?: (sendId: string) => Promise<null | (() => void)>
	isOnline?: () => boolean
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (h: unknown) => void
	maxParallel?: number
	retryDelaysMs?: number[]
	/** how many items the queue holds now (the chat write lock holds the page's reloads while > 0) */
	onDepth?: (count: number) => void
	/** what the queue holds, split for the reload hold (reloadHoldPolicy.ts): items that are not awaiting, items awaiting, and when the oldest awaiting item began to wait */
	onHold?: (hold: { firm: number; awaiting: number; awaitingSince: number | null; confirmed: number; firmSince: number | null }) => void
	now?: () => number
	onState?: (sendId: string, state: QueueState | 'removed') => void
	/** an attempt for this item starts (QA event stream; no content) */
	onAttemptStart?: (sendId: string) => void
	/** a kick happened: its trigger and how many attempts it started (QA event stream; no content) */
	onKick?: (trigger: KickTrigger, started: number) => void
	/**
	 * steady heartbeat: while a persisted item is waiting for anything (queued, failed, unknown, awaiting, confirmed) and the page is visible, the queue kicks every `heartbeatMs` (30 s) WITHOUT asking
	 * navigator.onLine: the events (online, visible, load) are not reliable in a shell WebView, so the retry does not depend on them or on the end of the timer chain.
	 * An attempt made while really offline fails cheaply and backs off.
	 */
	heartbeatMs?: number
	/** a confirmed item (the receipt was seen, the sent state or the library copy is not durable yet) is retried by the heartbeat at this slower pace (2-5 minutes; 3 minutes by default) */
	confirmedRetryMs?: number
	isVisible?: () => boolean
}

interface Slot {
	item: QueueItem
	state: QueueState
	persisted: boolean
	/** an attempt for this item has started (set in the same turn as the call, before any await): two triggers in one turn start one attempt */
	busy: boolean
	/** how many attempts have started for this item in this page load (QA state export; no content) */
	attempts: number
	/** when this item went `awaiting` (null while it is in any other state) */
	awaitingSince: number | null
	/** when this item went `confirmed` and has stayed so (receipt seen, sent state / library copy not durable): the backup notice runs on it (libraryBackupNotice.ts) */
	confirmedSince: number | null
	/** when the last attempt for this item started (0: none in this page load) */
	lastAttemptAt: number
	/** when this item entered the firm states (queued, inflight, failed, unknown, held, waiting) and has stayed in them (a retry that fails again keeps it); null while it is awaiting / confirmed. The reload-hold status of a failed item runs on it. */
	firmSince: number | null
	/** attempts that started since this item first went `awaiting` (0 while it is in any other state): the awaiting pace slows down with it */
	awaitAttempts: number
}

export type KickTrigger = 'load' | 'online' | 'visible' | 'timer' | 'manual' | 'heartbeat'

/** one entry of the kick log (QA state export): when, why, whether the page believed it was online, how many attempts it started */
export interface KickRecord {
	at: number
	trigger: KickTrigger
	online: boolean
	started: number
}

export const DEFAULT_HEARTBEAT_MS = 30_000
export const DEFAULT_CONFIRMED_RETRY_MS = 180_000
/**
 * the pace at which an `awaiting` item (the POST was accepted, no proof yet) is asked again by the steady ticks: 30 s, 1, 2, 5, then 10 minutes at most, counted from the item's first wait in this page load
 * (a restart begins again). Slowing down never releases the item: only proof does.
 */
export const AWAITING_RETRY_STEPS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000]
export const awaitingRetryDelayMs = (attemptsSoFar: number): number => AWAITING_RETRY_STEPS_MS[Math.min(Math.max(0, attemptsSoFar), AWAITING_RETRY_STEPS_MS.length - 1)]
const KICK_LOG_MAX = 40

export interface SendQueue {
	/** Writes the item (an upsert of its own document). The queue holds the page's reloads from this call on. With `inline` the item is marked inflight: the caller runs the first attempt itself (run(..., { inline: true })). */
	enqueue(item: QueueItem, opts?: { inline?: boolean }): Promise<{ ok: true } | { ok: false; error: unknown }>
	/** Reads the items of this conversation from disk into memory (after a reload). Returns them (oldest first). */
	load(): Promise<QueueItem[]>
	/** One attempt for the item (claimed). Returns the result, or 'skipped' when another attempt / tab has it or it is gone. */
	run(sendId: string, attempt: (item: QueueItem) => Promise<AttemptResult>, opts?: { inline?: boolean }): Promise<AttemptResult | 'skipped'>
	/** Starts an automatic attempt for every item that may be tried now (online, load, visible, timer). */
	kick(trigger: KickTrigger): void
	/** records the acceptance answer with the stored item; an item that is gone is never written back */
	recordReceipt(sendId: string, kind: 'bound' | 'legacy_empty'): Promise<void>
	/** The stored payload of a file / voice item (undefined for a text item or an item that is not held) */
	wireOf(sendId: string): string | undefined
	/** The inner armor of the item, persisted by the first attempt (undefined before that). */
	armorOf(sendId: string): string | undefined
	/** Persists the inner armor and its digest into the item's document (an upsert of that one document). Rejects when it did not land. */
	recordArmor(sendId: string, armor: string, digest: string): Promise<void>
	/**
	 * The armor context of one sendId for a send attempt. It never depends on the item being in memory: with no slot (a queue that was rebuilt and has not loaded yet) the item's own document is read, so a retry
	 * still posts the stored armor. `record` writes only while the stored armor is still the one read here (compare-and-write; else it rejects and nothing is sent). undefined only when the item has no document
	 * (nothing is persisted, nothing may be reused). Rejects when the document cannot be read or decoded: the caller keeps the attempt pending.
	 */
	armorContext(sendId: string): Promise<{ armor?: string; record: (armor: string, digest: string) => Promise<void> } | undefined>
	/** QA/test: how many per-sendId armor locks are held or queued right now (0 when idle). */
	armorLockCount(): number
	/** The state of the item in memory (undefined when it is not in the queue). */
	stateOf(sendId: string): QueueState | undefined
	/** An outcome that was reached outside run() (the held-retry path, a send that waited for the entry nodes): same rules as an attempt's result. Idempotent. */
	settle(sendId: string, result: AttemptResult): Promise<void>
	/** The user dropped the message on purpose. */
	drop(sendId: string): Promise<void>
	has(sendId: string): boolean
	snapshot(): Array<{ sendId: string; state: QueueState; text: string; attempts: number; confirmedSince: number | null; lastAttemptAt: number }>
	/** the last kicks (oldest first), for the QA state export; no content */
	kickLog(): KickRecord[]
	size(): number
	dispose(): void
}

export function createSendQueue(opts: SendQueueOptions): SendQueue {
	const slots = new Map<string, Slot>()
	const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
	const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
	const claim = opts.claim ?? (async () => () => undefined)
	const delays = opts.retryDelaysMs ?? [3000, 10000, 30000, 60000, 60000, 60000]
	const maxParallel = Math.max(1, opts.maxParallel ?? 3)
	let timer: unknown = null
	let hbTimer: unknown = null
	const kicks: KickRecord[] = []
	const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
	const confirmedRetryMs = opts.confirmedRetryMs ?? DEFAULT_CONFIRMED_RETRY_MS
	const visible = () => (opts.isVisible ? opts.isVisible() : typeof document === 'undefined' || document.visibilityState !== 'hidden')
	let autoRetries = 0
	let disposed = false
	let running = 0
	const waiting: Array<() => void> = []

	const nowMs = () => (opts.now ? opts.now() : Date.now())
	const depth = () => {
		opts.onDepth?.(slots.size)
		if (opts.onHold) {
			let firm = 0
			let awaiting = 0
			let firmSince: number | null = null
			let confirmed = 0 // of the soft items below: proof seen, only the local copy / backup is pending (these are NOT "awaiting confirmation" for the user)
			let since: number | null = null
			for (const s of slots.values()) {
				// soft = nothing is left to DO for the user's message, only a proof or a persistence to wait for (awaiting, confirmed): the item is safe on disk, so the reload hold on it has a limit (reloadHoldPolicy.ts)
				if (s.state === 'awaiting' || s.state === 'confirmed') {
					awaiting += 1
					if (s.state === 'confirmed') confirmed += 1
					if (s.awaitingSince !== null && (since === null || s.awaitingSince < since)) since = s.awaitingSince
				} else {
					firm += 1
					if (s.firmSince !== null && (firmSince === null || s.firmSince < firmSince)) firmSince = s.firmSince
				}
			}
			opts.onHold({ firm, awaiting, awaitingSince: since, confirmed, firmSince })
		}
		ensureHeartbeat()
	}
	/** the heartbeat runs while at least one persisted item is waiting for anything but the user (held items wait for the user and are not ticked) */
	const ensureHeartbeat = () => {
		if (disposed || heartbeatMs <= 0) return
		let waiting = false
		for (const s of slots.values()) {
			if (s.persisted && (s.state === 'queued' || s.state === 'failed' || s.state === 'unknown' || s.state === 'awaiting' || s.state === 'confirmed' || s.state === 'waiting')) { waiting = true; break }
		}
		if (!waiting) {
			if (hbTimer !== null) { clearTimer(hbTimer); hbTimer = null } // nothing is waiting any more: the heartbeat stops
			return
		}
		if (hbTimer !== null) return
		hbTimer = setTimer(() => {
			hbTimer = null
			if (disposed) return
			if (visible()) kick('heartbeat')
			ensureHeartbeat()
		}, heartbeatMs)
	}
	const setState = (s: Slot, state: QueueState) => {
		const was = s.state
		s.state = state
		// the clock of the reload hold: from the moment an item FIRST goes awaiting; the re-POST in between (inflight) and a result that is awaiting again keep it; any other state clears it
		if (state === 'awaiting' || state === 'confirmed') { if (s.awaitingSince === null) s.awaitingSince = nowMs() } else if (state !== 'inflight') s.awaitingSince = null
		if (state === 'confirmed') { if (s.confirmedSince === null) s.confirmedSince = nowMs() } else if (state !== 'inflight') s.confirmedSince = null
		if (state !== 'awaiting' && state !== 'inflight') s.awaitAttempts = 0
		if (state === 'awaiting' || state === 'confirmed') s.firmSince = null
		else if (s.firmSince === null) s.firmSince = nowMs()
		opts.onState?.(s.item.sendId, state)
		if (was !== state && slots.get(s.item.sendId) === s) depth()
	}
	const online = () => (opts.isOnline ? opts.isOnline() : true)

	const acquireSlot = (): Promise<void> => {
		if (running < maxParallel) {
			running += 1
			return Promise.resolve()
		}
		return new Promise((resolve) => waiting.push(() => { running += 1; resolve() }))
	}
	const releaseSlot = () => {
		running -= 1
		const next = waiting.shift()
		if (next) next()
	}

	const scheduleRetry = () => {
		if (disposed || timer !== null) return
		if (![...slots.values()].some((s) => s.persisted && (s.state === 'failed' || s.state === 'unknown' || s.state === 'confirmed' || s.state === 'awaiting' || s.state === 'waiting'))) return
		const delay = delays[Math.min(autoRetries, delays.length)]
		if (delay === undefined) return // automatic retries for this page load are used up; the next trigger (online, load, visible) starts again
		timer = setTimer(() => {
			timer = null
			autoRetries += 1
			kick('timer')
		}, delay)
	}

	const finish = async (s: Slot, result: AttemptResult): Promise<void> => {
		const id = s.item.sendId
		if (result.kind === 'awaiting') {
			setState(s, 'awaiting')
			return
		}
		if (result.kind === 'sent') {
			setState(s, 'confirmed')
			if (result.persisted) {
				try {
					await removeDocument(id, false)
					opts.onState?.(id, 'removed')
					depth()
					return
				} catch {
					return // the sent state is on disk; only the removal is retried (the item stays confirmed)
				}
			}
			return
		}
		setState(s, result.kind === 'held' ? 'held' : result.kind)
	}

	const run: SendQueue['run'] = async (sendId, attempt, runOpts) => {
		const s = slots.get(sendId)
		if (!s || !s.persisted && !runOpts?.inline) return 'skipped'
		if (s.busy) return 'skipped'
		s.busy = true
		const release = await claim(sendId).catch(() => null)
		if (!release) { s.busy = false; return 'skipped' } // another tab has it
		await acquireSlot()
		try {
			if (!runOpts?.inline) {
				// the document is read again after the claim: a tab that sent it meanwhile has removed it
				const onDisk = await opts.store.get(sendId).catch(() => s.item)
				if (!onDisk) {
					slots.delete(sendId)
					opts.onState?.(sendId, 'removed')
					depth()
					return 'skipped'
				}
				s.item = onDisk // the armor another tab stored meanwhile is the one to post
			}
			if (s.state === 'confirmed') {
				// the receipt was already seen: never send again, only write the sent state and remove the item
				s.lastAttemptAt = nowMs() // the heartbeat's slow pace for confirmed items counts from here
				let persisted = false
				try { persisted = await opts.persistConfirmed(s.item) } catch { persisted = false }
				await finish(s, { kind: 'sent', persisted })
				return { kind: 'sent', persisted }
			}
			setState(s, 'inflight')
			s.attempts += 1
			opts.onAttemptStart?.(sendId)
			if (s.awaitingSince !== null) s.awaitAttempts += 1
			s.lastAttemptAt = nowMs()
			let result: AttemptResult
			try {
				result = await attempt(s.item)
			} catch {
				result = { kind: 'unknown' }
			}
			await finish(s, result)
			return result
		} finally {
			s.busy = false
			releaseSlot()
			release()
			scheduleRetry()
		}
	}

	function kick(trigger: KickTrigger): void {
		if (disposed) return
		// an event (online, visible, load, manual) starts the back-off again; the timer and the heartbeat are the steady ticks and do not
		const steady = trigger === 'timer' || trigger === 'heartbeat'
		if (!steady) {
			autoRetries = 0
			if (timer !== null) { clearTimer(timer); timer = null }
		}
		const believesOnline = online()
		// the steady ticks never ask navigator.onLine: an attempt that is really offline fails cheaply, and the chain goes on
		if (!steady && !believesOnline) {
			kicks.push({ at: nowMs(), trigger, online: false, started: 0 })
			if (kicks.length > KICK_LOG_MAX) kicks.shift()
			opts.onKick?.(trigger, 0)
			return
		}
		let started = 0
		for (const [id, s] of [...slots.entries()]) {
			if (!s.persisted) continue
			if (s.state === 'queued' || s.state === 'failed' || s.state === 'unknown' || s.state === 'confirmed' || s.state === 'awaiting' || s.state === 'waiting') {
				// a confirmed item (nothing to send, only the sent state or the library copy to make durable) is ticked by the heartbeat at the slow pace
				if (trigger === 'heartbeat' && s.state === 'confirmed' && nowMs() - s.lastAttemptAt < confirmedRetryMs) continue
				// an awaiting item is asked again at a slowing pace (30 s, 1, 2, 5, 10 minutes), by the steady ticks only; an event (load, online, visible, manual) always tries once
				if (steady && s.state === 'awaiting' && nowMs() - s.lastAttemptAt < awaitingRetryDelayMs(s.awaitAttempts)) continue
				started += 1
				void run(id, opts.resume)
			}
		}
		kicks.push({ at: nowMs(), trigger, online: believesOnline, started })
		if (kicks.length > KICK_LOG_MAX) kicks.shift()
		opts.onKick?.(trigger, started)
	}

	const armorLocks = new Map<string, Promise<unknown>>()
	const withArmorLock = <T,>(sendId: string, fn: () => Promise<T>): Promise<T> => {
		const prev = armorLocks.get(sendId) ?? Promise.resolve()
		const next = prev.then(fn)
		const tail = next.then(() => undefined, () => undefined)
		armorLocks.set(sendId, tail)
		// the lock is released: with nobody queued behind it, the entry goes (the map never grows with the number of sendIds)
		void tail.then(() => { if (armorLocks.get(sendId) === tail) armorLocks.delete(sendId) })
		return next
	}

	/**
	 * Removing an item's document runs under the same per-sendId lock as an armor record, and the slot goes inside the lock: a record asked while (or after) the removal runs finds the item gone and writes nothing, so a
	 * removed document is never brought back. `forget` also drops the slot when the removal fails (the user dropped the message).
	 */
	const removeDocument = (sendId: string, forget: boolean): Promise<void> =>
		withArmorLock(sendId, async () => {
			try {
				await opts.store.remove(sendId)
				slots.delete(sendId)
			} finally {
				if (forget) slots.delete(sendId)
			}
		})

	async function armorContext(sendId: string): ReturnType<SendQueue['armorContext']> {
			// A write of an armor is a compare-and-write under a per-sendId lock: it lands only while the stored armor is still the one this attempt READ at its start. A second attempt that read the same (empty) value
			// finds a different one and fails ("nothing is sent"); its next attempt reuses the stored armor. So one sendId never leaves with two inner armors.
			const s = slots.get(sendId)
			if (s) {
				const seen = s.item.armor
				return {
					armor: seen,
					record: (armor, digest) => withArmorLock(sendId, async () => {
						// a disposed queue (the account or the conversation changed) writes nothing; an item that is no longer this queue's has been removed: a write would bring its document back
						if (disposed) throw new Error('queue_disposed')
						if (slots.get(sendId) !== s) throw new Error('queue_item_gone')
						if (s.item.armor !== seen) throw new Error('armor_changed')
						const next: QueueItem = { ...s.item, armor, armorDigest: digest }
						await opts.store.put(next)
						s.item = next
					}),
				}
			}
			// No slot: the item's own document. A read that fails or cannot be decoded is NOT "no document": it throws, the attempt stays pending and is counted by the caller.
			const look = await opts.store.inspect(sendId)
			if (look.kind === 'absent') return undefined
			if (look.kind === 'unreadable') throw new Error('queue_item_unreadable')
			const seen = look.item.armor
			return {
				armor: seen,
				record: (armor, digest) => withArmorLock(sendId, async () => {
					if (disposed) throw new Error('queue_disposed')
					const cur = await opts.store.inspect(sendId)
					if (cur.kind === 'absent') throw new Error('queue_item_gone')
					if (cur.kind !== 'item') throw new Error('queue_item_unreadable')
					if (cur.item.armor !== seen) throw new Error('armor_changed')
					const next: QueueItem = { ...cur.item, armor, armorDigest: digest }
					await opts.store.put(next)
					const live = slots.get(sendId)
					if (live) live.item = next
				}),
			}
		}

	return {
		async enqueue(item, enqOpts) {
			// an item of another conversation is refused: it would be listed and sent from the wrong one
			if (item.peer.trim().toLowerCase() !== opts.peer.trim().toLowerCase()) return { ok: false, error: new Error('queue_peer_mismatch') }
			if (slots.has(item.sendId)) return { ok: true }
			// from this call on the page's reloads are held: a new message must not be overtaken by a reload that was waiting for the queue to empty
			const slot: Slot = { item, state: enqOpts?.inline ? 'inflight' : 'queued', persisted: false, busy: false, attempts: 0, awaitingSince: null, confirmedSince: null, lastAttemptAt: 0, awaitAttempts: 0, firmSince: nowMs() }
			slots.set(item.sendId, slot)
			depth()
			try {
				await opts.store.put(item)
				slot.persisted = true
				ensureHeartbeat()
				return { ok: true }
			} catch (error) {
				slots.delete(item.sendId)
				depth()
				return { ok: false, error }
			}
		},
		wireOf: (sendId) => slots.get(sendId)?.item.wire,
		recordReceipt: (sendId, kind) => withArmorLock(sendId, async () => {
			const stored = await opts.store.get(sendId)
			if (!stored || stored.receipt === 'bound' || stored.receipt === kind) return
			const next: QueueItem = { ...stored, receipt: kind }
			await opts.store.put(next)
			const slot = slots.get(sendId)
			if (slot) slot.item = { ...slot.item, receipt: kind }
		}),
		async load() {
			const items = (await opts.store.list()).filter((i) => i.peer.toLowerCase() === opts.peer.toLowerCase())
			for (const item of items) {
				if (!slots.has(item.sendId)) slots.set(item.sendId, { item, state: 'queued', persisted: true, busy: false, attempts: 0, awaitingSince: null, confirmedSince: null, lastAttemptAt: 0, awaitAttempts: 0, firmSince: nowMs() })
			}
			depth()
			return items
		},
		run,
		kick,
		async settle(sendId, result) {
			const s = slots.get(sendId)
			if (!s) return
			await finish(s, result)
			if (result.kind === 'failed' || result.kind === 'unknown' || result.kind === 'awaiting' || result.kind === 'waiting' || (result.kind === 'sent' && !result.persisted)) scheduleRetry()
		},
		async drop(sendId) {
			const s = slots.get(sendId)
			if (!s) return
			try { await removeDocument(sendId, true) } catch { /* the document stays; the item is gone from memory and a restart would bring it back as queued */ }
			opts.onState?.(sendId, 'removed')
			depth()
		},
		armorOf: (sendId) => slots.get(sendId)?.item.armor,
		async recordArmor(sendId, armor, digest) {
			// the same compare-and-write as every armor record: the armor stored now must still be the one read just before
			const ctx = await armorContext(sendId)
			if (!ctx) throw new Error('queue_item_missing')
			await ctx.record(armor, digest)
		},
		armorContext,
		armorLockCount: () => armorLocks.size,
		stateOf: (sendId) => slots.get(sendId)?.state,
		has: (sendId) => slots.has(sendId),
		snapshot: () => [...slots.values()].map((s) => ({ sendId: s.item.sendId, state: s.state, text: s.item.text, attempts: s.attempts, confirmedSince: s.confirmedSince, lastAttemptAt: s.lastAttemptAt })),
		kickLog: () => [...kicks],
		size: () => slots.size,
		dispose() {
			disposed = true
			if (timer !== null) { clearTimer(timer); timer = null }
			if (hbTimer !== null) { clearTimer(hbTimer); hbTimer = null }
			slots.clear()
			depth()
		},
	}
}
