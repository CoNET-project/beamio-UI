/**
 * while a chat write is in progress the page does not refresh itself over it.
 *
 * - A writer (a message the user sends, a received batch, a stored status change) takes the lock BEFORE it changes the message list and releases it only when its write
 *   transaction has really committed (or has failed). It is a counter: with several writers at once the first to finish does not release; the last one does.
 * - While the lock is held, the page's own refreshes are deferred: the chat page's re-read of the stored copy, the history overlay (history entries merged into the chats), and the
 *   controllable reloads (service worker update, a retry reload). Requests with the same key are merged into one, and that one runs when the counter returns to zero.
 * - A network ACK, the end of a button animation, a fixed time or hiding a refresh button never count as "written". There is no timer in this file.
 * - A read that began before a write must not replace what the write stored: every write start moves a version; a read keeps the version it began at and is dropped (and asked
 *   again) when the version has moved.
 * - A failed write releases the lock (finally): the interactive state unlocks and the user can Retry. Releasing the lock is NOT permission to reload: a destructive reload (a service
 *   worker update, a controlled reload) is held while any message exists only in memory (its record never landed) and runs once after a retry has put it on disk. The harmless
 *   refreshes (the chat re-read, the history overlay) only read and merge, keep the in-memory temp messages, and run when the lock is free.
 * - A deferred action that throws does not stop the others.
 * A forced reload or a closed tab cannot be held back; the message is written (with its id) before the network request goes out and is recovered by id after the reload.
 */
import { clearAllPendingSends } from './pendingSends'
import { awaitingStatusOf, type AwaitingStatus } from './reloadHoldPolicy'
let depth = 0
let version = 0
/** Refreshes that only READ and MERGE (the chat re-read, the history overlay): they run when no writer is active. */
const deferred = new Map<string, () => void>()
/** Reloads (and anything else that throws the page's memory away): they run only when no writer is active AND no message exists only in memory. */
const deferredDestructive = new Map<string, () => void>()
/** Messages whose recoverable record has never landed on disk (id -> true). A failed write leaves them here; the page memory is then the only copy. */
const unsaved = new Set<string>()
/** Messages whose record has landed at least once (a later failed update of their state does not make them memory-only). */
const saved = new Set<string>()
/** conversations whose draft has changes that are not written yet (a draft only in memory) */
const dirtyDrafts = new Set<string>()
/** messages whose network request is in flight: a reload the app asks for waits for the answer (success or failure), it does not cut the request off */
const inFlight = new Set<string>()
/** how many items the send queue holds, per queue key (account + conversation). While any queue holds an item the page's own reloads are suspended; the last removal releases them once. */
export type QueueHold = { firm: number; awaiting: number; awaitingSince: number | null; /** of `awaiting`, how many are confirmed (proof seen, local copy pending); absent = 0 */ confirmed?: number; /** the earliest moment any firm (not awaiting, not confirmed) item entered its firm state; absent / null = unknown */ firmSince?: number | null }
const queueHolds = new Map<string, QueueHold>()
const queuedTotal = (): number => { let n = 0; for (const v of queueHolds.values()) n += v.firm + v.awaiting; return n }
const awaitingTotal = (): number => { let n = 0; for (const v of queueHolds.values()) n += v.awaiting; return n }
const firmTotal = (): number => { let n = 0; for (const v of queueHolds.values()) n += v.firm; return n }
/** the earliest moment any FIRM item began to wait (null: none is firm, or the queue did not say): the status of a failed item runs on it */
const oldestFirmSince = (): number | null => {
	let oldest: number | null = null
	for (const v of queueHolds.values()) if (v.firm > 0 && typeof v.firmSince === 'number' && (oldest === null || v.firmSince < oldest)) oldest = v.firmSince
	return oldest
}
const confirmedTotal = (): number => { let n = 0; for (const v of queueHolds.values()) n += v.confirmed ?? 0; return n }
/** the oldest moment any awaiting item began to wait (null: none is awaiting) */
const oldestAwaitingSince = (): number | null => {
	let oldest: number | null = null
	for (const v of queueHolds.values()) if (v.awaiting > 0 && v.awaitingSince !== null && (oldest === null || v.awaitingSince < oldest)) oldest = v.awaitingSince
	return oldest
}
/**
 * True while the queue holds the reload: ANY item in the queue (firm or awaiting), however long it has waited. while the send queue is not empty the app's controllable
 * reload stays suspended; there is no age limit and no override. The 30 s and 4 min marks of reloadHoldPolicy.ts only decide what the status SHOWS (reloadHoldAwaitingStatus). A system-level refresh or a killed
 * process is not decided here: it is accepted by the recovery from disk (the queue documents).
 */
const queueBlocks = (): boolean => firmTotal() > 0 || awaitingTotal() > 0
const holdsReload = (): boolean => unsaved.size > 0 || dirtyDrafts.size > 0 || inFlight.size > 0 || queueBlocks()
/**
 * the soft items are of two kinds and the user must not be told the wrong one: `awaiting` (the entry accepted the POST, no proof yet: "awaiting confirmation", with Retry) and `confirmed`
 * (the receipt is in, only the local copy / backup is pending: "local backup is still retrying"). Display only: both hold the reload exactly the same.
 * `awaiting` when at least one soft item is still waiting for proof; `confirmed` when every soft item is confirmed; `none` without soft items.
 */
export function reloadHoldSoftKind(): 'none' | 'awaiting' | 'confirmed' {
	const soft = awaitingTotal()
	if (soft === 0) return 'none'
	return confirmedTotal() >= soft ? 'confirmed' : 'awaiting'
}
/** The status tier of the FIRM items (queued, failed, unknown, held): from the earliest moment one of them began to wait. Display only, like the awaiting tiers. */
export function reloadHoldFirmStatus(now: number = Date.now()): AwaitingStatus {
	return awaitingStatusOf(firmTotal() > 0 ? oldestFirmSince() : null, now)
}

/**
 * what the page shows while a reload is held, whoever asked for it. `held` is true while an application-requested or user-requested reload is waiting; the interface shows a standing
 * status line from it without any key press. `count` is how many items cause the hold (firm items for the `queue` reason, soft items for `awaiting`). Read only; nothing here lets a reload through.
 */
export interface ReloadHoldView { held: boolean; reason: ReloadHoldReason | null; soft: 'none' | 'awaiting' | 'confirmed'; awaitingStatus: AwaitingStatus; firmStatus: AwaitingStatus; count: number }
export function reloadHoldView(now: number = Date.now()): ReloadHoldView {
	const reason = reloadHoldReason()
	const count = reason === 'queue' ? firmTotal() : reason === 'awaiting' ? awaitingTotal() : 0
	return { held: deferredDestructive.size > 0 && reason !== null, reason, soft: reloadHoldSoftKind(), awaitingStatus: reloadHoldAwaitingStatus(now), firmStatus: reloadHoldFirmStatus(now), count }
}
const holdViewListeners = new Set<() => void>()
/** The interface hears when a reload becomes held or the hold changes or ends (any request, not only a button). Returns the unsubscribe function. */
export function onReloadHoldChange(listener: () => void): () => void {
	holdViewListeners.add(listener)
	return () => { holdViewListeners.delete(listener) }
}
function notifyHoldChange(): void {
	for (const l of [...holdViewListeners]) {
		try { l() } catch { /* a listener that throws does not stop the others */ }
	}
}

/** What the held reload should SAY about the awaiting items (display only: nothing in this file lets a reload through because of it). */
export function reloadHoldAwaitingStatus(now: number = Date.now()): AwaitingStatus {
	return awaitingStatusOf(awaitingTotal() > 0 ? oldestAwaitingSince() : null, now)
}

/** Takes the lock. The returned function releases it once (calling it again does nothing). */
export function beginChatWrite(): () => void {
	depth += 1
	version += 1
	let released = false
	return () => {
		if (released) return
		released = true
		depth = Math.max(0, depth - 1)
		if (depth === 0) runDeferred()
	}
}

/** Runs the task under the lock. The lock is released when the task has settled, whether it resolved or threw. */
export async function runChatWrite<T>(task: () => Promise<T>): Promise<T> {
	const release = beginChatWrite()
	try {
		return await task()
	} finally {
		release()
	}
}

export function isChatWriting(): boolean {
	return depth > 0
}

/** The version a read keeps when it begins; see readIsStale. */
export function chatWriteVersion(): number {
	return version
}

/** True when a write has started since the read began (the read result is older than a write and must not be applied). */
export function readIsStale(readVersion: number): boolean {
	return version !== readVersion
}

/**
 * Runs `action` now when no write is in progress (returns false). Otherwise keeps it under `key` (the later request with the same key replaces the earlier one: several requests
 * are one) and runs it once when the last writer has released (returns true).
 */
export function deferWhileWriting(key: string, action: () => void): boolean {
	if (depth === 0) {
		action()
		return false
	}
	deferred.set(key, action)
	return true
}

function runDeferred(): void {
	if (depth > 0) return
	const refreshes = [...deferred.values()]
	deferred.clear()
	for (const action of refreshes) {
		try {
			action()
		} catch {
			/* a deferred refresh that throws does not stop the others */
		}
	}
	// A destructive reload waits for the STATE, not only for the lock: it does not run while a message is still only in memory (a failed write releases the lock so the user can
	// retry, but the held reload stays held until a retry has put the record on disk, or the message is dropped on purpose)
	if (holdsReload()) { notifyHoldChange(); return }
	const reloads = [...deferredDestructive.values()]
	deferredDestructive.clear()
	for (const action of reloads) {
		if (reloadAlreadyIssued()) break
		try {
			issueReload(action)
		} catch {
			/* a deferred reload that throws does not stop the others */
		}
	}
	notifyHoldChange()
}

/** A message is about to be written for the first time: until its record has landed it exists only in memory. (A message that has landed before is not memory-only again.) */
export function noteMessageSaving(id: string): void {
	if (id && !saved.has(id)) unsaved.add(id)
}

/** The record of this message has landed (or the user dropped it on purpose): it no longer holds a destructive reload back. Runs what was held if nothing else holds it. */
export function noteMessageSaved(id: string): void {
	if (!id) return
	saved.add(id)
	unsaved.delete(id)
	runDeferred()
}

/** A message the user dropped on purpose (a failed message removed): it needs no record and holds nothing back. */
export function noteMessageDropped(id: string): void {
	if (!id) return
	unsaved.delete(id)
	runDeferred()
}

export function hasUnsavedMessages(): boolean {
	return unsaved.size > 0
}

/** The draft of a conversation has changes that are not written (memory only). A destructive reload waits for the write. */
export function noteDraftDirty(key: string): void {
	if (key) dirtyDrafts.add(key)
}

/** The draft of the conversation is written. Runs what was held if nothing else holds it. */
export function noteDraftSaved(key: string): void {
	if (!key) return
	dirtyDrafts.delete(key)
	runDeferred()
}

/** The network request of a message has gone out and has no answer yet. */
export function noteRequestInFlight(id: string): void {
	if (id) inFlight.add(id)
}

/** The request has its answer (it succeeded or failed). Runs what was held if nothing else holds it. */
export function noteRequestSettled(id: string): void {
	if (!id) return
	inFlight.delete(id)
	runDeferred()
}

/**
 * A reload that the app asks for (not the browser's own refresh). Held while a write is in progress, and held while any message exists only in memory (a write that failed): done once,
 * after the last record has landed. Idle with nothing unsaved: it runs at once.
 */
/**
 * the reload that has been issued (or is about to be) and when. A burst of requests in the same turn (a service-worker update fires its listener more than once, a button is tapped twice)
 * results in ONE reload: the first call reloads and the others of the same burst are merged into it (they return `true`: the reload is
 * under way, nothing more to do). A reload that did not unload the page (blocked, or an embedder that ignores it) can be asked for again after RELOAD_MERGE_MS.
 */
const RELOAD_MERGE_MS = 5000
let reloadIssuedAt = 0
const reloadAlreadyIssued = (): boolean => reloadIssuedAt !== 0 && Date.now() - reloadIssuedAt < RELOAD_MERGE_MS
const issueReload = (reload: () => void): void => {
	reloadIssuedAt = Date.now()
	reload()
}

export function requestControlledReload(reload: () => void = () => window.location.reload()): boolean {
	if (reloadAlreadyIssued()) return true // merged into the reload that is already under way
	if (depth === 0 && !holdsReload()) {
		issueReload(reload)
		return false
	}
	deferredDestructive.set('controlled-reload', reload)
	notifyHoldChange()
	return true
}

/**
 * The reload after the user deleted the local wallet (the confirmed reset on the lock screen). It goes through the same single entry as every other reload. The holds are dropped first: what they stand for
 * (queued, unsaved or drafted messages of that wallet) has just been erased on the user's confirmation, so nothing could ever release them and the reset would be left half done.
 */
export function requestReloadAfterLocalWipe(reload?: () => void): boolean {
	depth = 0
	unsaved.clear()
	saved.clear()
	dirtyDrafts.clear()
	inFlight.clear()
	queueHolds.clear()
	// what an earlier, held request left behind would run again later (after the merge window): it goes with the holds
	deferred.clear()
	deferredDestructive.clear()
	// every other source a leave / reload decision reads is dropped with them
	clearAllPendingSends()
	return requestControlledReload(reload)
}

/** The send queue of a conversation now holds `count` items (0: it is empty). Runs what was held when nothing holds it any more. */
export function setQueueHold(key: string, hold: QueueHold): void {
	if (!key) return
	if (hold.firm + hold.awaiting > 0) queueHolds.set(key, hold)
	else queueHolds.delete(key)
	if (!holdsReload()) runDeferred()
	notifyHoldChange()
}

/** The queue holds `count` items, none of them awaiting (the form the older callers use). */
export function setQueueDepth(key: string, count: number): void {
	setQueueHold(key, { firm: Math.max(0, count), awaiting: 0, awaitingSince: null })
}

export type ReloadHoldReason = 'writing' | 'unsaved' | 'queue' | 'awaiting' | 'draft' | 'inflight'

/** Why a reload that the app asks for is held right now (null: nothing holds it). The order is the order of what the user can act on. */
export function reloadHoldReason(): ReloadHoldReason | null {
	if (depth > 0) return 'writing'
	if (unsaved.size > 0) return 'unsaved'
	if (firmTotal() > 0) return 'queue'
	if (queueBlocks()) return 'awaiting'
	if (dirtyDrafts.size > 0) return 'draft'
	if (inFlight.size > 0) return 'inflight'
	return null
}

const heldListeners = new Set<(reason: ReloadHoldReason) => void>()

/** The UI hears when a reload the USER asked for (a button) is held, so that the tap is never silent (reloadHeldNotice.ts shows a toast). Returns the unsubscribe function. */
export function onUserReloadHeld(listener: (reason: ReloadHoldReason) => void): () => void {
	heldListeners.add(listener)
	return () => { heldListeners.delete(listener) }
}

/**
 * the reload of a button the user pressed (identity closed, PGP regenerate, first identity, storage retry, Go to Home). It is held exactly like requestControlledReload
 * (same key, same state), but when it is held the listeners are told why, so that the tap shows a message and a way out instead of doing nothing: wait (a write / a request is in
 * progress) or Retry the message that is not saved.
 */
export function requestUserReload(reload: () => void = () => window.location.reload()): boolean {
	// no override. A tap while the queue is not empty is held like the app's own reload, whatever the awaiting items have waited; the toast says what is going on (reloadHeldNotice.ts)
	const held = requestControlledReload(reload)
	if (held) {
		const reason = reloadHoldReason()
		if (reason) {
			for (const l of [...heldListeners]) {
				try { l(reason) } catch { /* a listener that throws does not stop the others */ }
			}
		}
	}
	return held
}

/** What is held right now (for the QA hook; read only). */
export function chatWriteLockState(): { writing: boolean; unsaved: number; queued: number; awaiting: number; dirtyDrafts: number; inFlight: number; heldReload: boolean; heldRefreshes: number } {
	return { writing: depth > 0, unsaved: unsaved.size, queued: queuedTotal(), awaiting: awaitingTotal(), dirtyDrafts: dirtyDrafts.size, inFlight: inFlight.size, heldReload: deferredDestructive.size > 0, heldRefreshes: deferred.size }
}

/**
 * The in-page entry of the controlled reload, for QA (a way to trigger "the app refreshes itself" from the page: `window.__beamioRequestControlledReload`), and a read-only
 * state (`window.__beamioChatWriteLockState`). Present in every build on purpose: the first only asks for the same held reload the app itself asks for (no data, no privilege beyond
 * what the page can already do with location.reload), the second returns four counters. There is no write-failure injection here: the account record is written on the page thread
 * (PouchDB / IndexedDB), so QA intercepts it there.
 */
if (typeof window !== 'undefined') {
	const w = window as unknown as Record<string, unknown>
	w.__beamioRequestControlledReload = () => requestControlledReload()
	w.__beamioChatWriteLockState = () => chatWriteLockState()
}

/** Test hook: a cold start of the module state. */
export function resetChatWriteLockForTest(): void {
	depth = 0
	version = 0
	deferred.clear()
	deferredDestructive.clear()
	unsaved.clear()
	saved.clear()
	dirtyDrafts.clear()
	inFlight.clear()
	queueHolds.clear()
	reloadIssuedAt = 0
	heldListeners.clear()
	holdViewListeners.clear()
}
