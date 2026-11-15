/**
 * The shell's pending server sync. A profile update that could not reach the server is queued
 * and re-sent later, also after a restart.
 *
 * The queue keeps only the account address (EOA), a generation, a failure count and the retry schedule. It never keeps a private
 * key or a request body: the re-send is built from the latest local state at send time.
 *
 * Outcomes: `sent`removes the item. `deferred`keeps it pending and is not counted as a failure: the account is not in
 * memory yet, this session has no EOA key (it waits for a read that gives the key), a network error, or a transient server answer.
 * `failed` is an explicit server refusal and counts one; after MAX_FAILURES the item is failed (kept, visible through the API, not
 * in the notice). Every retry waits longer than the last (backoff, capped at a few minutes), and the retries never stop on time.
 *
 * Generations are never reused: one increasing sequence, persisted, so an item that is removed and queued again never
 * shares a generation with a request that is still in flight. A request that completes removes the item only if its generation is
 * unchanged.
 */
import { backoffDelayMs } from './retryBackoff'

export const PENDING_SERVER_SYNC_KEY = 'beamio.shell.pendingServerSync.v1'
const PENDING_SERVER_SYNC_SEQ_KEY = 'beamio.shell.pendingServerSync.seq.v1'
export const PENDING_SERVER_SYNC_MAX_FAILURES = 20
/** The base delay of the retry backoff: the first retry waits this long; each later one waits twice as long, up to the cap. */
export const PENDING_SERVER_SYNC_INTERVAL_MS = 15_000
/** Dispatched on window whenever the queue changes (the notice listens). */
export const PENDING_SERVER_SYNC_EVENT = 'beamio:pending-server-sync'

export type PendingSyncItem = { eoa: string; queuedAt: number; failures: number; gen: number; attempts: number; nextAt: number }
export type PendingSyncStatus = 'none' | 'pending' | 'failed'
/** The result of one re-send: sent (the server has it), deferred (waits, not a failure), failed (an explicit server refusal). */
export type FlushOutcome = 'sent' | 'deferred' | 'failed'

let flushing = false
/** a deferred page write held in memory only (storage quota): the notice shows (the approved copy). */
let deferredLocalOnly = false
let sender: ((eoa: string) => Promise<FlushOutcome>) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let memorySeq = 0

function storage(): Storage | null {
	try {
		return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
	} catch {
		return null
	}
}

function isItem(v: unknown): v is PendingSyncItem {
	if (!v || typeof v !== 'object') return false
	const o = v as Record<string, unknown>
	return typeof o.eoa === 'string' && typeof o.queuedAt === 'number' && typeof o.failures === 'number'
}

/** The queue as stored (a bad entry is ignored; nothing secret is ever in it). Entries from an older build get the new fields. */
export function pendingServerSyncItems(): PendingSyncItem[] {
	const raw = storage()?.getItem(PENDING_SERVER_SYNC_KEY)
	if (!raw) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter(isItem).map((i) => ({
			eoa: i.eoa,
			queuedAt: i.queuedAt,
			failures: i.failures,
			gen: typeof i.gen === 'number' ? i.gen : 0,
			attempts: typeof i.attempts === 'number' ? i.attempts : 0,
			nextAt: typeof i.nextAt === 'number' ? i.nextAt : 0,
		}))
	} catch {
		return []
	}
}

function save(items: PendingSyncItem[]): void {
	const s = storage()
	if (s) {
		if (items.length === 0) s.removeItem(PENDING_SERVER_SYNC_KEY)
		else s.setItem(PENDING_SERVER_SYNC_KEY, JSON.stringify(items))
	}
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(PENDING_SERVER_SYNC_EVENT))
}

/** The next generation: larger than every generation given before, also across a restart (the sequence is persisted). */
function nextGeneration(): number {
	const s = storage()
	let persisted = 0
	try {
		persisted = Number(s?.getItem(PENDING_SERVER_SYNC_SEQ_KEY) ?? 0) || 0
	} catch {
		persisted = 0
	}
	const next = Math.max(memorySeq, persisted) + 1
	memorySeq = next
	try {
		s?.setItem(PENDING_SERVER_SYNC_SEQ_KEY, String(next))
	} catch {
		/* kept in memory only */
	}
	return next
}

const keyOf = (eoa: string): string => eoa.trim().toLowerCase()

/** The generation of one account's item (0 when nothing is queued). A request captures it when it starts. */
export function pendingServerSyncGeneration(eoa: string): number {
	return pendingServerSyncItems().find((i) => i.eoa === keyOf(eoa))?.gen ?? 0
}

/**
 * Queues the account for a re-send. A save is a new intent: it gets a new generation, is sent at the next tick, and its
 * failure count starts again (an item at MAX_FAILURES is retried only by such a new save).
 */
export function enqueuePendingServerSync(eoa: string, now: number = Date.now()): void {
	const key = keyOf(eoa)
	if (!key) return
	const items = pendingServerSyncItems()
	const hit = items.find((i) => i.eoa === key)
	if (hit) {
		hit.gen = nextGeneration()
		hit.failures = 0
		hit.attempts = 0
		hit.nextAt = 0
	} else {
		items.push({ eoa: key, queuedAt: now, failures: 0, gen: nextGeneration(), attempts: 0, nextAt: 0 })
	}
	save(items)
	ensureLoop()
}

/**
 * A re-send from the queue that did not succeed keeps the queued item and its count (it is not a new intent). The item is added only
 * when it is missing.
 */
export function ensurePendingServerSync(eoa: string, now: number = Date.now()): void {
	const key = keyOf(eoa)
	if (!key) return
	const items = pendingServerSyncItems()
	if (items.some((i) => i.eoa === key)) return
	items.push({ eoa: key, queuedAt: now, failures: 0, gen: nextGeneration(), attempts: 0, nextAt: 0 })
	save(items)
	ensureLoop()
}

/** a deferred page write is held in memory only (no storage). The notice shows while it is held. */
export function setDeferredLocalOnly(held: boolean): void {
	if (deferredLocalOnly === held) return
	deferredLocalOnly = held
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(PENDING_SERVER_SYNC_EVENT))
}

/**
 * The item is done. Without a generation, the item is removed. With the generation a request captured when it started, the item
 * is removed only if it has not changed since (a newer queued intent is kept, so it is re-sent).
 */
export function completePendingServerSync(eoa: string, startedGen?: number): void {
	const key = keyOf(eoa)
	const items = pendingServerSyncItems()
	const hit = items.find((i) => i.eoa === key)
	if (!hit) return
	if (startedGen !== undefined && hit.gen !== startedGen) return
	save(items.filter((i) => i.eoa !== key))
}

/** The state of one account's sync: none, pending (will be retried), or failed (kept, visible, after MAX_FAILURES). */
export function pendingServerSyncStatus(eoa: string): PendingSyncStatus {
	const item = pendingServerSyncItems().find((i) => i.eoa === keyOf(eoa))
	if (!item) return 'none'
	return item.failures >= PENDING_SERVER_SYNC_MAX_FAILURES ? 'failed' : 'pending'
}

/** The notice shows only unsynced items that are still being retried. */
export function pendingServerSyncNoticeVisible(): boolean {
	return deferredLocalOnly || pendingServerSyncItems().some((i) => i.failures < PENDING_SERVER_SYNC_MAX_FAILURES)
}

/**
 * Re-sends every item that is due and may still be retried, with the sender (which builds the request from the latest local state).
 * Returns the number of items still queued. One flush at a time. Each item's generation is captured before its send. A `sent`
 * removes the item only if its generation is unchanged; a failure or deferral always moves that item's retry schedule forward.
 */
export async function flushPendingServerSync(send: (eoa: string) => Promise<FlushOutcome>, now: number = Date.now()): Promise<number> {
	if (flushing) return pendingServerSyncItems().length
	flushing = true
	try {
		for (const item of pendingServerSyncItems()) {
			if (item.failures >= PENDING_SERVER_SYNC_MAX_FAILURES) continue
			if (item.nextAt > now) continue
			const startedGen = item.gen
			let outcome: FlushOutcome
			try {
				outcome = await send(item.eoa)
			} catch {
				// An error is not an explicit server refusal: it waits and is retried.
				outcome = 'deferred'
			}
			if (outcome === 'sent') {
				completePendingServerSync(item.eoa, startedGen)
				continue
			}
			save(
				pendingServerSyncItems().map((i) => {
					// a failure or a deferral counts only against the request's own generation; a newer intent keeps its count.
					if (i.eoa !== item.eoa || i.gen !== startedGen) return i
					const attempts = i.attempts + 1
					return {
						...i,
						attempts,
						failures: outcome === 'failed' ? i.failures + 1 : i.failures,
						nextAt: now + backoffDelayMs(PENDING_SERVER_SYNC_INTERVAL_MS, attempts),
					}
				}),
			)
		}
		return pendingServerSyncItems().length
	} finally {
		flushing = false
	}
}

/**
 * A caller's view of one profile sync: true when the server does not have the latest state (queued). The
 * caller must check it explicitly: a 'deferred' result is a string, never a success.
 */
export function profileSyncPending(eoa: string, result: boolean | 'deferred'): boolean {
	return result !== true && pendingServerSyncStatus(eoa) !== 'none'
}

/** Registers the sender once (the shell) and starts the retry loop when items are queued (also after a restart). */
export function registerPendingSender(send: (eoa: string) => Promise<FlushOutcome>): void {
	sender = send
	ensureLoop()
}

function retryable(): boolean {
	return pendingServerSyncItems().some((i) => i.failures < PENDING_SERVER_SYNC_MAX_FAILURES)
}

function ensureLoop(): void {
	if (!sender || timer !== null || !retryable()) return
	timer = setTimeout(async () => {
		timer = null
		const current = sender
		if (current) await flushPendingServerSync(current)
		ensureLoop()
	}, PENDING_SERVER_SYNC_INTERVAL_MS)
}

/** Test-only: the module state. */
export function resetPendingServerSyncForTest(): void {
	flushing = false
	sender = null
	memorySeq = 0
	deferredLocalOnly = false
	if (timer !== null) clearTimeout(timer)
	timer = null
}
