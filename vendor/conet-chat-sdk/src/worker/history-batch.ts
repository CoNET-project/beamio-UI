/**
 * Batched history writes: the rules, the per-entry pending queue and the commit step. The wire format is the existing one (one encrypted fragment per message, one encrypted index, one pointer); this module
 * decides WHEN a batch is written and keeps what is waiting.
 *
 * Trigger: the 10th waiting entry at once, or 2 minutes after the OLDEST waiting entry was queued, whichever comes first. No added delay: no random wait, no minimum gap since the last write, no wait after a
 * restart. A later entry never moves the clock, and entries left over after a write keep their own queue time. Only a failed write backs off, and a lost pointer race waits briefly.
 *
 * Queue: one sealed document per entry, so two tabs adding entries cannot drop each other's. A queue that cannot be listed, read or opened is an ERROR, never an empty queue, and an unreadable document is never
 * written over. A write counts only when it reads back (a store that ignores a failed write is caught).
 *
 * Pointer: the head and the nonce are read together (one block, one node) immediately before every signature. The batch in flight is recorded before the first submission, so a confirmation that never comes back
 * has a way out: head = this batch: done; head = the head the batch was built on: sign with the current nonce and submit; any other head: build again on it; head not readable: stop.
 * An entry counts as in the head only when a read of the head shows the batch. It counts as ARCHIVED only when EVERY object of its batch (each fragment and the index) has a pin result bound to this very request
 * (identifier, length, a fresh random value) with the content checked by the node; one object short confirms nothing. Without a way to ask (`askPinned`) nothing is ever archived.
 *
 * Reused from the earlier batched writer (commit 7d3603b3): the stable record key, the entry order, the entry count and age constants, the failure backoff and pointer-race delay formulas.
 */
import { aesGcmDecryptString, aesGcmEncryptString, keccakUtf8 } from '../crypto.js'

export const BATCH_MAX_ENTRIES = 10
export const BATCH_MAX_AGE_MS = 120_000
export const BATCH_RETRY_BASE_MS = 30_000
export const BATCH_RETRY_MAX_MS = 600_000
export const BATCH_CAS_ATTEMPTS = 3
export const BATCH_CAS_DELAY_MIN_MS = 1_000
export const BATCH_CAS_DELAY_MAX_MS = 5_000

export const BATCH_ENTRY_PREFIX = 'beamio.chat.history.batch:'
export const BATCH_FLIGHT_PREFIX = 'beamio.chat.history.batchflight:'

export interface BatchItem { peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string }
export type ArchiveState = 'queued' | 'committed' | 'archived'
export interface ArchiveEntry {
	v: 1
	key: string
	peer: string
	dir: 'in' | 'out'
	ts: number
	sendId?: string
	/** kept until the entry is archived */
	body?: string
	enqueuedAt: number
	state: ArchiveState
	/** the index a read of the head showed holding this entry */
	indexHash?: string
	/** with indexHash: the length of that index text, and this entry's fragment */
	indexLength?: number
	object?: ObjectRef
}
/** one stored object: its content identifier (keccak256 of the text) and the length of that text */
export interface ObjectRef { hash: string; length: number }
/** what is asked: the object and a random value made for this request only */
export interface PinRequest extends ObjectRef { nonce: string }
/** the normalized answer for one object. The wire fields are not defined yet: no adapter produces this today. */
export interface PinResult { state: string; hash: string; length: number; nonce: string; contentVerified: boolean }

/** true only when every request has its own result: state exactly 'pinned', the same identifier, length and random value, and content checked. Anything missing or different: false for the whole set. */
export function pinCoversAll(requests: readonly PinRequest[], results: readonly PinResult[] | null | undefined): boolean {
	if (!requests.length || !Array.isArray(results)) return false
	return requests.every((q) => results.some((r) => !!r && r.state === 'pinned' && r.contentVerified === true && typeof r.hash === 'string' && r.hash.toLowerCase() === q.hash.toLowerCase() && r.length === q.length && r.nonce === q.nonce))
}
const freshNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

export type QueueErrorCode = 'queue_unavailable' | 'queue_unreadable' | 'queue_write_failed'
export class ArchiveQueueError extends Error {
	constructor(public readonly code: QueueErrorCode) { super(code) }
}

/** the sendId when present, otherwise a content hash, so a second mirror of the same entry is recognised: `"h:" + keccak256(utf8(peer|dir|ts|body)).slice(2, 34)` */
export function historyRecordKey(entry: { sendId?: string; peer: string; dir: string; ts: number; body: string }): string {
	if (entry.sendId) return entry.sendId
	return `h:${keccakUtf8(`${entry.peer.toLowerCase()}|${entry.dir}|${entry.ts}|${entry.body}`).slice(2, 34)}`
}

/** the order in which waiting entries are chained after the committed tail */
export function orderEntries<T extends { ts: number; key: string }>(entries: readonly T[]): T[] {
	return [...entries].sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export type TriggerReason = 'count' | 'age'
export interface TriggerPlan {
	due: TriggerReason | null
	/** when to look again; null: nothing is waiting */
	at: number | null
}
/** derived from the stored entries alone, so nothing can restart or postpone the clock */
export function planTrigger(entries: readonly ArchiveEntry[], now: number): TriggerPlan {
	const queued = entries.filter((e) => e.state === 'queued')
	if (!queued.length) return { due: null, at: null }
	if (queued.length >= BATCH_MAX_ENTRIES) return { due: 'count', at: now }
	const at = Math.min(...queued.map((e) => e.enqueuedAt)) + BATCH_MAX_AGE_MS
	return at <= now ? { due: 'age', at: now } : { due: null, at }
}

export const batchRetryDelay = (failures: number, random: () => number): number =>
	Math.floor(Math.min(BATCH_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), BATCH_RETRY_MAX_MS) * (0.5 + random()))
export const casRetryDelay = (random: () => number): number => Math.floor(BATCH_CAS_DELAY_MIN_MS + random() * (BATCH_CAS_DELAY_MAX_MS - BATCH_CAS_DELAY_MIN_MS))

export interface HeadSnapshot {
	/** null: this wallet never wrote */
	head: string | null
	nonce: string
}
export interface Flight { baseHead: string | null; indexHash: string; indexLength: number; keys: string[]; objects: Record<string, ObjectRef>; recordCount: number; batch: number; /** the sealed bytes of this batch by identifier: a later try sends the SAME bytes again */ texts?: Record<string, string> }

/** what to do with the batch in flight for a head just read */
export function decideFlight(head: string | null, flight: Pick<Flight, 'baseHead' | 'indexHash'>): 'landed' | 'submit' | 'rebuild' {
	const norm = (h: string | null) => (h === null ? null : h.toLowerCase())
	if (norm(head) === norm(flight.indexHash)) return 'landed'
	return norm(head) === norm(flight.baseHead) ? 'submit' : 'rebuild'
}

export interface QueuePersistence {
	get(key: string): Promise<unknown | undefined>
	set(key: string, value: unknown): Promise<void>
	keys?(prefix: string): Promise<string[]>
}

export class ArchiveQueue {
	private readonly eoa: string
	constructor(private readonly store: QueuePersistence, eoa: string, private readonly key: Uint8Array) {
		this.eoa = eoa.toLowerCase()
	}
	private entryPrefix(): string { return `${BATCH_ENTRY_PREFIX}${this.eoa}:` }
	private entryName(recordKey: string): string { return `${this.entryPrefix()}${keccakUtf8(recordKey).slice(2, 34)}` }
	private flightName(): string { return `${BATCH_FLIGHT_PREFIX}${this.eoa}` }

	private async names(prefix: string): Promise<string[]> {
		if (!this.store.keys) throw new ArchiveQueueError('queue_unavailable')
		try { return await this.store.keys(prefix) } catch { throw new ArchiveQueueError('queue_unreadable') }
	}
	/** a document that is listed must be readable and open: anything else throws */
	private async openDoc(name: string): Promise<unknown> {
		try {
			const sealed = await this.store.get(name)
			if (typeof sealed !== 'string' || !sealed) throw new Error('absent')
			const box = JSON.parse(await aesGcmDecryptString(this.key, sealed)) as { name?: unknown; value?: unknown }
			// the name is sealed with the value: a document moved to another name does not open
			if (box?.name !== name) throw new Error('moved')
			return box.value
		} catch {
			throw new ArchiveQueueError('queue_unreadable')
		}
	}
	/** the document, or undefined only when the listing confirms there is none */
	private async readDoc(name: string): Promise<unknown | undefined> {
		return (await this.names(name)).includes(name) ? this.openDoc(name) : undefined
	}
	private async writeDoc(name: string, value: unknown): Promise<void> {
		const sealed = await aesGcmEncryptString(this.key, JSON.stringify({ name, value }))
		try {
			await this.store.set(name, sealed)
			if ((await this.store.get(name)) !== sealed) throw new Error('not_stored')
		} catch {
			throw new ArchiveQueueError('queue_write_failed')
		}
	}

	private static isEntry(v: unknown): v is ArchiveEntry {
		const e = v as ArchiveEntry
		return !!e && e.v === 1 && typeof e.key === 'string' && typeof e.enqueuedAt === 'number' && (e.state === 'archived' || ((e.state === 'queued' || e.state === 'committed') && typeof e.body === 'string'))
	}
	private async entryAt(name: string, value: unknown): Promise<ArchiveEntry> {
		if (!ArchiveQueue.isEntry(value) || this.entryName(value.key) !== name) throw new ArchiveQueueError('queue_unreadable')
		return value
	}
	async get(recordKey: string): Promise<ArchiveEntry | undefined> {
		const name = this.entryName(recordKey)
		const value = await this.readDoc(name)
		return value === undefined ? undefined : this.entryAt(name, value)
	}
	/** adds the entry unless it is held already (then its state is returned and nothing changes, its queue time included). Resolves only once it is on disk. */
	async enqueue(item: BatchItem, now: number): Promise<{ state: ArchiveState; added: boolean }> {
		const recordKey = historyRecordKey(item)
		const held = await this.get(recordKey)
		if (held) return { state: held.state, added: false }
		await this.writeDoc(this.entryName(recordKey), { v: 1, key: recordKey, peer: item.peer.toLowerCase(), dir: item.dir, ts: item.ts, ...(item.sendId ? { sendId: item.sendId } : {}), body: item.body, enqueuedAt: now, state: 'queued' } satisfies ArchiveEntry)
		return { state: 'queued', added: true }
	}
	/** every readable entry, and how many documents could not be read (they stay as they are). The listing itself failing throws. */
	async list(): Promise<{ entries: ArchiveEntry[]; unreadable: number }> {
		const entries: ArchiveEntry[] = []
		let unreadable = 0
		for (const name of await this.names(this.entryPrefix())) {
			try { entries.push(await this.entryAt(name, await this.openDoc(name))) } catch { unreadable += 1 }
		}
		return { entries, unreadable }
	}
	async update(entry: ArchiveEntry): Promise<void> {
		await this.writeDoc(this.entryName(entry.key), entry)
	}
	async readFlight(): Promise<Flight | null> {
		const value = (await this.readDoc(this.flightName())) as { flight?: Flight | null } | undefined
		if (value === undefined || value.flight === null) return null
		const f = value.flight
		if (!f || typeof f.indexHash !== 'string' || !Array.isArray(f.keys)) throw new ArchiveQueueError('queue_unreadable')
		return f
	}
	/** null marks "none in flight" (the document stays) */
	async writeFlight(flight: Flight | null): Promise<void> {
		await this.writeDoc(this.flightName(), { flight })
	}
}

export type PointerAnswer = 'ok' | 'conflict' | 'rejected' | 'unknown'
export interface BatchNet<R> {
	/** head and nonce from one block of one node; null: it could not be read (never "no pointer") */
	readSnapshot(): Promise<HeadSnapshot | null>
	/** the records of that head's index, the fragment of each record key, and the length of the index text; null: not readable */
	loadIndex(head: string | null): Promise<{ records: R[]; keys: Map<string, ObjectRef>; indexLength: number } | null>
	/** encrypts `entries` after `records`, uploads their fragments and then the new index; null: something did not upload */
	prepare(records: R[], entries: ArchiveEntry[]): Promise<{ index: ObjectRef; objects: Record<string, ObjectRef>; recordCount: number; texts?: Record<string, string> } | null>
	/** signs with the nonce of `snapshot` and submits */
	submitPointer(flight: Flight, snapshot: HeadSnapshot): Promise<PointerAnswer>
	/** asks for a freshly checked pin result for each object (a repeated upload must be checked anew, never answered from before). No such interface exists today: absent, nothing is ever archived. */
	askPinned?(requests: PinRequest[], texts?: Record<string, string>): Promise<PinResult[] | null>
}

export type BatchTraceEvent = 'queued_first' | 'trigger_count' | 'trigger_age' | 'objects_uploaded' | 'pointer_submitted' | 'head_shows_batch' | 'pin_confirmed' | 'pin_unavailable'
/** times, counts and a local batch number only: no text, key, address or content hash */
export interface BatchTrace { event: BatchTraceEvent; at: number; batch: number; count: number }

export type FlushOutcome = 'idle' | 'waiting' | 'backoff' | 'committed' | 'not_pinned' | 'head_unreadable' | 'upload_failed' | 'awaiting_head' | 'pointer_rejected' | 'conflict_exhausted' | 'queue_error'

export class BatchWriter<R> {
	private running: Promise<FlushOutcome> | null = null
	private failures = 0
	private notBefore = 0
	private batchNo = 0
	private pinNoted = new Set<string>()
	constructor(
		private readonly deps: {
			queue: ArchiveQueue
			net: BatchNet<R>
			now?: () => number
			random?: () => number
			sleep?: (ms: number) => Promise<void>
			trace?: (t: BatchTrace) => void
			/** entries that are now archived (the only state a mailbox acknowledgement may rest on) */
			onArchived?: (keys: string[]) => void
		},
	) {}
	/** asks about every object, each under its own fresh random value; true only when all are covered */
	private async provePinned(objects: ObjectRef[], texts?: Record<string, string>): Promise<boolean> {
		if (!this.deps.net.askPinned) return false
		const requests: PinRequest[] = objects.map((o) => ({ hash: o.hash, length: o.length, nonce: freshNonce() }))
		const results = await this.deps.net.askPinned(requests.map((q) => ({ ...q })), texts).catch(() => null)
		return pinCoversAll(requests, results)
	}
	private now(): number { return this.deps.now ? this.deps.now() : Date.now() }
	private note(event: BatchTraceEvent, count: number, batch = this.batchNo): void { this.deps.trace?.({ event, at: this.now(), batch, count }) }

	async enqueue(item: BatchItem): Promise<ArchiveState> {
		const first = !(await this.deps.queue.list()).entries.some((e) => e.state === 'queued')
		const r = await this.deps.queue.enqueue(item, this.now())
		if (r.added && first) this.note('queued_first', 1, this.batchNo + 1)
		return r.state
	}

	/** when run() has something to do next; null: nothing is waiting */
	async nextWakeAt(): Promise<number | null> {
		const { entries } = await this.deps.queue.list()
		const plan = planTrigger(entries, this.now())
		const flight = await this.deps.queue.readFlight()
		let at = flight ? this.now() : plan.at
		// entries waiting for a pin confirmation are asked about again later; with no way to ask there is nothing to wake for
		if (this.deps.net.askPinned && entries.some((e) => e.state === 'committed')) at = Math.min(at ?? Infinity, this.now() + BATCH_RETRY_BASE_MS)
		return at === null ? null : Math.max(at, this.notBefore)
	}

	/** one pass, single flight: a second call while one runs gets the same result. `force` skips the trigger (not the backoff). */
	run(force = false): Promise<FlushOutcome> {
		this.running ??= this.pass(force)
			.catch((e: unknown) => { if (e instanceof ArchiveQueueError) return 'queue_error' as const; throw e })
			.then((outcome) => {
				if (outcome === 'committed' || outcome === 'idle') { this.failures = 0; this.notBefore = 0 }
				else if (outcome !== 'waiting' && outcome !== 'backoff') { this.failures += 1; this.notBefore = this.now() + batchRetryDelay(this.failures, this.deps.random ?? Math.random) }
				return outcome
			})
			.finally(() => { this.running = null })
		return this.running
	}

	private async pass(force: boolean): Promise<FlushOutcome> {
		await this.confirm()
		if (this.now() < this.notBefore) return 'backoff'
		const { net, queue } = this.deps
		let triggered = false
		let rebuilds = 0
		for (let attempt = 1; attempt <= BATCH_CAS_ATTEMPTS; attempt++) {
			let flight = await queue.readFlight()
			if (!flight) {
				const { entries } = await queue.list()
				const plan = planTrigger(entries, this.now())
				if (plan.at === null) return 'idle'
				if (!plan.due && !force && !triggered) return 'waiting'
				if (!triggered) {
					triggered = true
					this.batchNo += 1
					if (plan.due) this.note(plan.due === 'count' ? 'trigger_count' : 'trigger_age', entries.filter((e) => e.state === 'queued').length)
				}
				const snapshot = await net.readSnapshot()
				if (!snapshot) return 'head_unreadable'
				const index = await net.loadIndex(snapshot.head)
				if (!index) return 'head_unreadable'
				const queued = entries.filter((e) => e.state === 'queued')
				// already in the head (a lost confirmation, another tab or device): not written again
				const present = queued.filter((e) => index.keys.has(e.key))
				if (present.length && snapshot.head !== null) await this.committed(present.map((e) => e.key), { hash: snapshot.head, length: index.indexLength }, Object.fromEntries(index.keys))
				const rest = orderEntries(queued.filter((e) => !index.keys.has(e.key)))
				if (!rest.length) { await this.confirm(); return 'committed' }
				const prepared = await net.prepare(index.records, rest)
				if (!prepared) return 'upload_failed'
				this.note('objects_uploaded', rest.length)
				if (!rest.every((e) => prepared.objects[e.key])) return 'upload_failed'
				flight = { baseHead: snapshot.head, indexHash: prepared.index.hash, indexLength: prepared.index.length, keys: rest.map((e) => e.key), objects: prepared.objects, recordCount: prepared.recordCount, batch: this.batchNo, ...(prepared.texts ? { texts: prepared.texts } : {}) }
				await queue.writeFlight(flight)
			}
			// FIXED ORDER: every new object of the batch and the index are proven pinned, THEN the pointer is signed, THEN the entries are confirmed. There is no switch.
			// The proof lives only in this pass: it is never stored, so it cannot serve a later try or another batch.
			let proven = false
			const now = await net.readSnapshot()
			if (!now) return 'head_unreadable'
			// a batch that is in the head already, or whose base moved, needs no proof before the decision below
			if (decideFlight(now.head, flight) === 'submit') {
				proven = await this.provePinned(this.objectsOf(flight), flight.texts)
				if (!proven) {
					if (!net.askPinned) this.note('pin_unavailable', flight.keys.length, flight.batch)
					return 'not_pinned'
				}
				this.note('pin_confirmed', flight.keys.length, flight.batch)
			}
			// head and nonce again, immediately before the signature
			const before = await net.readSnapshot()
			if (!before) return 'head_unreadable'
			const decision = decideFlight(before.head, flight)
			if (decision === 'landed') return this.landed(flight, proven)
			if (decision === 'rebuild') {
				await queue.writeFlight(null)
				triggered = true
				force = true
				// building again is not an attempt at the pointer (bounded on its own)
				if (rebuilds++ < BATCH_CAS_ATTEMPTS) attempt -= 1
				continue
			}
			const answer = await net.submitPointer(flight, before).catch((): PointerAnswer => 'unknown')
			this.note('pointer_submitted', flight.keys.length, flight.batch)
			const after = await net.readSnapshot()
			if (!after) return 'head_unreadable'
			if (decideFlight(after.head, flight) === 'landed') return this.landed(flight, proven)
			if (answer === 'conflict') {
				if (attempt < BATCH_CAS_ATTEMPTS) await (this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(casRetryDelay(this.deps.random ?? Math.random))
				continue
			}
			// the batch stays in flight; the next run decides from the head
			return answer === 'rejected' ? 'pointer_rejected' : 'awaiting_head'
		}
		return 'conflict_exhausted'
	}

	private objectsOf(flight: Flight): ObjectRef[] {
		return [...flight.keys.map((k) => flight.objects[k]!), { hash: flight.indexHash, length: flight.indexLength }]
	}
	private async landed(flight: Flight, proven: boolean): Promise<FlushOutcome> {
		await this.committed(flight.keys, { hash: flight.indexHash, length: flight.indexLength }, flight.objects)
		this.note('head_shows_batch', flight.keys.length, flight.batch)
		// proved in this pass: archived now; otherwise (the head already showed the batch: a lost confirmation) asked while the bytes are still at hand
		if (proven) await this.archive(flight.keys)
		else if (await this.provePinned(this.objectsOf(flight), flight.texts)) {
			this.note('pin_confirmed', flight.keys.length, flight.batch)
			await this.archive(flight.keys)
		}
		await this.deps.queue.writeFlight(null)
		await this.confirm()
		return 'committed'
	}
	private async committed(keys: string[], index: ObjectRef, objects: Record<string, ObjectRef>): Promise<void> {
		for (const key of keys) {
			const entry = await this.deps.queue.get(key)
			if (entry?.state === 'queued') await this.deps.queue.update({ ...entry, state: 'committed', indexHash: index.hash, indexLength: index.length, object: objects[key] })
		}
	}
	/** entries in the head become archived only on a pin confirmation */
	private async confirm(): Promise<void> {
		const { entries } = await this.deps.queue.list()
		const waiting = new Map<string, ArchiveEntry[]>()
		for (const e of entries) if (e.state === 'committed' && e.indexHash) waiting.set(e.indexHash, [...(waiting.get(e.indexHash) ?? []), e])
		for (const [indexHash, group] of waiting) {
			if (!this.deps.net.askPinned) {
				if (!this.pinNoted.has(indexHash)) { this.pinNoted.add(indexHash); this.note('pin_unavailable', group.length) }
				continue
			}
			// every fragment of the group and the index, each under its own fresh random value; an entry whose fragment is not known confirms nothing
			if (!group.every((e) => e.object && typeof e.indexLength === 'number')) continue
			if (!(await this.provePinned([...group.map((e) => e.object!), { hash: indexHash, length: group[0]!.indexLength! }]))) continue
			this.note('pin_confirmed', group.length)
			await this.archive(group.map((e) => e.key))
		}
	}
	private async archive(keys: string[]): Promise<void> {
		const done: string[] = []
		for (const key of keys) {
			const entry = await this.deps.queue.get(key)
			if (entry?.state !== 'committed') continue
			const { body: _body, ...rest } = entry
			await this.deps.queue.update({ ...rest, state: 'archived' })
			done.push(key)
		}
		if (done.length) this.deps.onArchived?.(done)
	}
}
