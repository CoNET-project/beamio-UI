/**
 * SDK-side chat preheat, browser runtime only (the recorded rule; sdk-roles-chat-preheat.v1 SDR-08..SDR-14;
 * the recorded rule: inside a native shell the PWA does no IPFS prefetch).
 *
 * States (status codes only, see the log line):
 * - `requested`: the worker start and the history load were requested at account-ready. Nothing is known about the history yet.
 * - `ready`: the completion signal arrived: the worker's history tail batch was delivered (`isTail`, the on-chain pointer read,
 *   the IPFS index fetched and the tail decrypted). Empty history also completes.
 * - `failed`: the worker start failed, or no tail arrived within the bound.
 *
 * - startChatPreheat is non-blocking: it returns at once and the caller never awaits it to continue the wallet start or the home.
 * - awaitChatPreheat joins the same in-flight preheat (no second fetch).
 * - Passcode: no gate here. Chat access while the UI is locked is refused by the UI chat access guard (passcode/chatAccessGuard.ts,
 *   chatAccessRefused), which the send and history entry points call before any bridge request (unit e is the single authority).
 * - Logs carry status codes and timings only: never the mnemonic, keys, or chat content.
 *
 * Module state is per cold start (a new JS realm). SYNTHETIC values only in tests.
 */

import { qaEvent } from '../utils/qaAckOrder'

export type ChatPreheatState = 'idle' | 'requested' | 'ready' | 'failed'

export interface ChatPreheatDeps {
	/** Account identifier. Used only to keep one preheat per account; never logged. */
	accountKey: string
	/** True inside a native shell: no preheat runs there (the native SDK owns the shell chat preheat). */
	shell: boolean
	/** A handle to the mnemonic for the chat/worker side. Stored as a closure; never logged or returned. */
	mnemonicHandle?: () => string | null
	/** Starts the worker (the browser chat start). The worker's history load runs when the worker is ready. Errors make the preheat `failed`. */
	startWorker: () => unknown
	/** The completion signal: resolves true when the history tail is decrypted and delivered, false on failure or timeout. */
	awaitHistoryTail: () => Promise<boolean>
	log?: (line: string) => void
	now?: () => number
}

type Preheat = {
	accountKey: string
	promise: Promise<boolean>
	state: ChatPreheatState
	mnemonic: (() => string | null) | null
}

const defaultLog = (line: string): void => {
	if (typeof console !== 'undefined') console.info(line)
}

let current: Preheat | null = null

/** Status line: codes and timing only. */
const emit = (log: (line: string) => void, state: ChatPreheatState, startedAt: number, now: () => number): void => {
	log(`[sdk] preheat state=${state} ms=${Math.max(0, now() - startedAt)}`)
	// hook variant only: the console line above is removed from a production-style build, so the state change is also an event (preheat_requested / preheat_ready / preheat_failed)
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') qaEvent(`preheat_${state}`)
}

/**
 * Starts the browser preheat for this account (single-flight). Returns at once. A second call for the same account (and not failed)
 * joins the existing preheat. In a shell it returns false with no call and no log.
 */
export function startChatPreheat(deps: ChatPreheatDeps): Promise<boolean> {
	if (deps.shell) return Promise.resolve(false)
	const log = deps.log ?? defaultLog
	const now = deps.now ?? (() => Date.now())
	if (current && current.accountKey === deps.accountKey && current.state !== 'failed') return current.promise
	const startedAt = now()
	const entry: Preheat = {
		accountKey: deps.accountKey,
		promise: Promise.resolve(false),
		state: 'requested',
		mnemonic: deps.mnemonicHandle ?? null,
	}
	emit(log, 'requested', startedAt, now)
	current = entry
	// the worker start and the completion wait are both begun here, before the caller continues (the wait is bounded by the waiter)
	let started: Promise<unknown>
	try {
		started = Promise.resolve(deps.startWorker())
	} catch {
		started = Promise.reject(new Error('worker start threw'))
	}
	let tail: Promise<boolean>
	try {
		tail = Promise.resolve(deps.awaitHistoryTail())
	} catch {
		tail = Promise.resolve(false)
	}
	entry.promise = Promise.all([started, tail])
		.then(([, ok]) => {
			if (!ok) throw new Error('no history tail')
			entry.state = 'ready'
			emit(log, 'ready', startedAt, now)
			return true
		})
		.catch(() => {
			if (current === entry) entry.state = 'failed'
			emit(log, 'failed', startedAt, now)
			return false
		})
	return entry.promise
}

/** The UI's read of the prepared history: joins the in-flight preheat. Resolves false at once when none is running. */
export function awaitChatPreheat(): Promise<boolean> {
	return current ? current.promise : Promise.resolve(false)
}

/**
 * the conversation's LOCAL library read does not wait for the whole preheat. The preheat's completion signal (the history tail batch) may not come at all
 * (the worker only emits a tail batch when it decrypted NEW rows). The library read is local and needs no sync.
 *  - the library already answers (`switched` or `purged`): read at once, no wait;
 *  - anything else (not answered yet, or a record-based library): join the preheat for at most PREHEAT_JOIN_MAX_MS, then read anyway. 3 s: long enough for an almost-finished preheat to hand over its prepared history,
 *    short enough that no screen waits for the 90 s bound. The 90 s bound itself is NOT lowered (the preheat keeps its own state and log).
 */
export const PREHEAT_JOIN_MAX_MS = 3_000
export function preheatWaitPlan(libraryState: string | null): { wait: boolean; boundMs: number } {
	if (libraryState === 'switched' || libraryState === 'purged') return { wait: false, boundMs: 0 }
	return { wait: true, boundMs: PREHEAT_JOIN_MAX_MS }
}

/**
 * the library state is read BEFORE the preheat wait and again after it: a state that was unknown before the wait may be known after it, and a known state is never replaced by an unknown one.
 */
export const isMigratedState = (state: string | null): boolean => state === 'switched' || state === 'purged'
export const resolveLibraryState = (before: string | null, after: string | null): string | null => (after !== null ? after : before)
/** Still unknown after the wait although the library page came back local: ask once more shortly (at most MAX_UNKNOWN_STATE_RETRIES per mount), so the page is not left without its library messages. */
export const MAX_UNKNOWN_STATE_RETRIES = 3
export const UNKNOWN_STATE_RETRY_MS = 2_000
export function unknownStateRetryOf(input: { state: string | null; pageLocal: boolean; retries: number }): boolean {
	return input.state === null && input.pageLocal && input.retries < MAX_UNKNOWN_STATE_RETRIES
}

/** Joins a promise for at most `boundMs`: resolves false when the bound is reached first. */
export function awaitBounded(p: Promise<boolean>, boundMs: number, setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms), clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>)): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimer(() => resolve(false), Math.max(0, boundMs))
		p.then((v) => { clearTimer(timer); resolve(v) }, () => { clearTimer(timer); resolve(false) })
	})
}

/** The current preheat state (or 'idle'). Status only. */
export function chatPreheatState(): ChatPreheatState {
	return current ? current.state : 'idle'
}

/** Test and cold-start reset only. The App does not call this. */
export function resetChatPreheatForTest(): void {
	current = null
}
