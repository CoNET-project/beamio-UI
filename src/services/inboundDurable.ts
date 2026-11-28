/**
 * the mailbox ACK of an inbound chat line waits for the history append, in library mode.
 *
 * Why. In library mode (and `guarded`, chatLocalPurge.ts libraryPersistModeFor) the account record keeps no message bodies; the message reaches the library only through `history.append` (worker/history.ts,
 * serial, in the worker). So a committed account record says nothing about the body, and the mailbox ACK is the LAST step: it goes out only after the worker confirmed the append (`mirrorChatMessageToHistoryAck`).
 *
 * What it relies on: an un-ACKed line stays in the mailbox and is sent again, byte for byte (same armor hash), when the page listens again; it is not assumed to be resent inside a live session. So this
 * module does two things: (1) the page keeps the line "pending durable" IN MEMORY and retries the append with a back-off, ACKing only after a confirmed append; (2) a page that ends first has sent no ACK,
 * so the mailbox delivers the line again on the next listen and the append dedupes by sendId (worker/history.ts hasSendId).
 * Nothing here writes anything on `pagehide` / `beforeunload` / `unload` / `visibilitychange`: recovery after a crash does not depend on a page-exit write.
 *
 * Pure logic, no page state: the caller (App.tsx) supplies the append, the mark/unmark of the dedupe markers and the ACK.
 */

import { qaEvent } from '../utils/qaAckOrder'

/** One new inbound row's history append: the first attempt (already started) and a way to ask again. The append is idempotent per sendId. */
export type DurableMirror = {
	/** the first attempt, already running; resolves true only when the worker confirmed the append */
	done: Promise<boolean>
	/** ask again (a new append request for the same message) */
	retry: () => Promise<boolean>
	/** the message's sendId, when it has one. A row whose append is not confirmed shows the "not saved" state in the chat (unsavedInboundSendIds), keyed by it. */
	sendId?: string
	/** the page's own key of the message (App: processedIds / storedRowKeys): lets the page forget the line when its wait is abandoned */
	msgKey?: string
	/** why the last attempt failed: `local` (not confirmed as saved) or a remote step (upload / pointer / index / nofrag: the local copy is saved, the remote commit is pending). Absent: unknown, treated as local. */
	failure?: () => 'local' | 'upload' | 'pointer' | 'index' | 'nofrag' | undefined
}

export type DurableOptions = {
	/** pause between attempts; default setTimeout */
	sleep?: (ms: number) => Promise<void>
	/** how long one attempt may take before it counts as "no confirmation" (the worker serialises appends, a backlog is slow: ~10 s per record); default 120 s */
	waitMs?: number
	/** pause before attempt n+1 (the last value repeats); default 2, 5, 15, 30, 60 s */
	backoffMs?: readonly number[]
	/** false: the page moved to another account or is shutting down: stop (no ACK; the mailbox redelivers on the next listen) */
	alive?: () => boolean
	/** the wait of this message was abandoned (the account changed): the page forgets the line so the mailbox's redelivery is processed again, not taken as already handled */
	onAbandoned?: (mirror: DurableMirror) => void
	/** one line per failed attempt and per release after a failure: counts only (never a hash, a sendId, a peer or content) */
	log?: (message: string) => void
}

export const DURABLE_WAIT_MS = 120_000
export const DURABLE_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]

export type DurableAckDeps = {
	/** mailbox ACK for these armor hashes. Called only after a confirmed append. */
	ackMailbox: (armorHashes: string[]) => void
	/** back as dedupe markers after the append finally succeeded */
	markHashes: (armorHashes: string[]) => string[] | void
	/** kept for the settle step's own rollback; the wait itself no longer calls it */
	unmarkHashes: (armorHashes: string[]) => void
}

/** armor hashes whose append is not confirmed yet and whose retry loop is running on this page: they must not be ACKed by any other path (a redelivered copy that the page sees as a duplicate) */
const pending = new Set<string>()

/** counters of this page session (visible in the log lines and for tests): failed attempts, attempts after the first, ACKs sent after a confirmed append, waits that ended without an ACK (account moved / page going) */
const counters = { failures: 0, retries: 0, confirmed: 0, abandoned: 0 }

/**
 * inbound rows that are DISPLAYED but whose history append is not confirmed (the library write keeps failing or hangs): armor hash -> sendId. The chat marks those messages "not saved" in the message's
 * own status line (chat.status.not_saved) and the page clears the mark by itself when the append is confirmed. In memory only (a refresh drops it: the un-ACKed line comes back from the mailbox).
 */
const unsaved = new Map<string, string>()
let unsavedSnapshot: ReadonlySet<string> = new Set()
const unsavedListeners = new Set<() => void>()
/**
 * a second kind of unconfirmed row. The local copy IS saved (index record, fragment cache, library row) but the remote commit (fragment, index, pointer) has not succeeded: the chat says "saved here, remote not
 * committed" (chat.status.remote_pending), not "not saved". The two sets are exclusive per hash; both clear when the append is finally confirmed.
 */
const remoteUnsent = new Map<string, string>()
let remoteUnsentSnapshot: ReadonlySet<string> = new Set()
const publishUnsaved = (): void => {
	unsavedSnapshot = new Set(unsaved.values())
	remoteUnsentSnapshot = new Set(remoteUnsent.values())
	for (const l of [...unsavedListeners]) { try { l() } catch { /* a listener never decides anything */ } }
}
const markUnsaved = (hash: string, sendId: string | undefined): void => {
	if (!sendId) return
	const wasRemote = remoteUnsent.delete(hash)
	if (!wasRemote && unsaved.get(hash) === sendId) return
	unsaved.set(hash, sendId)
	publishUnsaved()
}
const markRemoteUnsent = (hash: string, sendId: string | undefined): void => {
	if (!sendId) return
	const wasLocal = unsaved.delete(hash)
	if (!wasLocal && remoteUnsent.get(hash) === sendId) return
	remoteUnsent.set(hash, sendId)
	publishUnsaved()
}
const clearUnsaved = (hash: string): void => {
	const a = unsaved.delete(hash)
	const b = remoteUnsent.delete(hash)
	if (a || b) publishUnsaved()
}
/** the sendIds of the displayed inbound messages that are not saved yet (a new Set on every change) */
export const unsavedInboundSendIds = (): ReadonlySet<string> => unsavedSnapshot
/** the sendIds whose local copy is saved but whose remote commit is not (a new Set on every change) */
export const remoteUnsentInboundSendIds = (): ReadonlySet<string> => remoteUnsentSnapshot
export const subscribeUnsavedInbound = (listener: () => void): (() => void) => {
	unsavedListeners.add(listener)
	return () => { unsavedListeners.delete(listener) }
}

export const isDurablePending = (armorHash: string): boolean => pending.has(armorHash)
export const durablePendingCount = (): number => pending.size
export const durableStats = (): { pending: number; failures: number; retries: number; confirmed: number; abandoned: number } => ({ pending: pending.size, ...counters })
export const resetDurablePendingForTest = (): void => {
	pending.clear()
	unsaved.clear()
	remoteUnsent.clear()
	publishUnsaved()
	counters.failures = counters.retries = counters.confirmed = counters.abandoned = 0
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** true only when the attempt resolved true within `ms`; a rejection, false or a timeout is "no confirmation" */
function confirmedWithin(attempt: () => Promise<boolean>, ms: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), ms)
		let p: Promise<boolean>
		try {
			p = attempt()
		} catch {
			clearTimeout(timer)
			resolve(false)
			return
		}
		p.then(
			(v) => { clearTimeout(timer); resolve(v === true) },
			() => { clearTimeout(timer); resolve(false) },
		)
	})
}

/**
 * Starts the wait-then-ACK for each (hash, mirror). The hashes are registered as pending SYNCHRONOUSLY, before this returns, so the caller can exclude them from its immediate ACK in the same step.
 * Returns the promise of all loops (the page ignores it; tests await it). A hash that is already pending has its own loop: it is not started twice.
 */
export function startDurableAck(
	items: ReadonlyArray<{ hash: string; mirror: DurableMirror }>,
	deps: DurableAckDeps,
	opts: DurableOptions = {},
): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep
	const waitMs = opts.waitMs ?? DURABLE_WAIT_MS
	const backoff = opts.backoffMs && opts.backoffMs.length ? opts.backoffMs : DURABLE_BACKOFF_MS
	const started = items.filter((it) => {
		if (pending.has(it.hash)) return false
		pending.add(it.hash)
		return true
	})
	const run = async (item: { hash: string; mirror: DurableMirror }): Promise<void> => {
		let failedHere = 0
		const say = (message: string): void => { try { opts.log?.(message) } catch { /* a log line never decides anything */ } }
		try {
			for (let attempt = 0; ; attempt++) {
				if (attempt > 0) counters.retries += 1
				const ok = await confirmedWithin(attempt === 0 ? () => item.mirror.done : item.mirror.retry, waitMs)
				if (ok) {
					// the dedupe marker of a waiting hash is set only now, after the confirmed append and before the ACK (the settle step does not mark it before the commit: a marker that reached disk
					// without the library row would make the redelivery after a kill look handled and be ACKed with no append)
					try { deps.markHashes([item.hash]) } catch { /* the ACK still goes: the append is confirmed */ }
					// diagnostics only: the wait's own ACK (sendId tail, hash tail); the time is the event's own
					if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') qaEvent('ack_wait', item.mirror.sendId, `h${item.hash.toLowerCase().replace(/[^0-9a-f]/g, '').slice(-8)}`)
					deps.ackMailbox([item.hash]) // the LAST step: only after the confirmed append
					clearUnsaved(item.hash) // saved: the "not saved" mark goes by itself
					counters.confirmed += 1
					if (failedHere) say(`mailbox ACK sent after a confirmed append, after ${failedHere} failed attempt(s); pending=${pending.size - 1} failures=${counters.failures}`)
					return
				}
				failedHere += 1
				counters.failures += 1
				// a failure that names a remote step means the local copy is saved and the remote commit is pending: the chat says that (not "not saved") until the append is confirmed
				let why: ReturnType<NonNullable<DurableMirror['failure']>> = undefined
				try { why = item.mirror.failure?.() } catch { /* unknown: treated as local */ }
				if (why && why !== 'local') {
					markRemoteUnsent(item.hash, item.mirror.sendId)
					// diagnostics only: sendId tail, hash tail 8 and the step code (never a text)
					if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') qaEvent('remote_fail', item.mirror.sendId, `h${item.hash.toLowerCase().replace(/[^0-9a-f]/g, '').slice(-8)}_${why}`)
				} else markUnsaved(item.hash, item.mirror.sendId) // displayed but not saved: the chat says so until the append is confirmed
				say(`history append not confirmed, mailbox ACK held (the mailbox keeps the line); attempt=${attempt + 1} pending=${pending.size} failures=${counters.failures}`)
				// (no marker was set before the confirmation, so nothing is taken back here)
				if (opts.alive && !opts.alive()) { counters.abandoned += 1; clearUnsaved(item.hash); try { opts.onAbandoned?.(item.mirror) } catch { /* the page's own bookkeeping never decides anything */ } return }
				await sleep(backoff[Math.min(attempt, backoff.length - 1)] as number)
				if (opts.alive && !opts.alive()) { counters.abandoned += 1; clearUnsaved(item.hash); try { opts.onAbandoned?.(item.mirror) } catch { /* the page's own bookkeeping never decides anything */ } return }
			}
		} finally {
			pending.delete(item.hash)
		}
	}
	return Promise.all(started.map(run)).then(() => undefined)
}
