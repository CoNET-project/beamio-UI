/**
 * PGP migration runner (a not_ready answer is asked again, never final).
 *
 * It sends `pgpMigrate` over the native channel and keeps the page state in memory. It never generates a key, never clears a record, and shows
 * nothing by itself: the Chat page reads `getPgpMigrationState()` (only `retryable` shows a notice).
 *
 * - `not_ready` and a timeout are unknown, never final: `started` is set only by a DECISIVE result (verified, chain_backup, needs_manual,
 *   approval_pending, refused). They are asked again after each answer on the cold-start schedule (1, 2, 4, 8, 16 s, then every 16 s, a 180 s
 *   window), one request at a time. With the window used up, a run is started again on these events, once each: the identity first ready
 *   (pgpReady true), the chat started, the app back in the foreground; and it is polled every 30 s while the chat page is visible.
 * - `no_key` (state `unavailable`) is not retried by itself; it is asked again once after the chat identity is ready, a first identity is
 *   done, or the account switches.
 * - A late `pgpMigrateResult` whose reqId is the latest request is taken (it only changes the page state, it triggers no write).
 * - The log carries the state name and the attempt number only.
 */
import { requestNativeAck, nextReqId } from './nativeChatRouteRegister'
import { NATIVE_EVENT_NAMES, eventPayloadOf } from './nativeKeyState'
import { interpretPgpMigrateEvent, pageStateForDecision, runPgpMigration, type MigrationPageState } from './pgpMigrationClient'
import { createColdStartBackoff } from './coldStartBackoff'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export type PgpMigrationRunState = 'idle' | 'running' | MigrationPageState

// a real interruption sends no event (checkpoint always continues in production); the request waits 45 s before it is called slow
const TIMEOUT_MS = 45_000
export const PGP_MIGRATE_POLL_MS = 30_000
/** The results that settle the run for this session. not_ready, a timeout (retryable), locked, busy and unavailable (no_key) do not. */
const DECISIVE: readonly MigrationPageState[] = ['verified', 'chain_backup', 'needs_manual', 'approval_pending', 'refused']

let state: PgpMigrationRunState = 'idle'
let decided = false
let inFlight = false
let lastReqId: number | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let backoff = createColdStartBackoff()
/** the events that already re-sent after the window was used up (each once) */
const resentFor = new Set<string>()
let noKeyRetried = false
let lateListening = false
const listeners = new Set<(s: PgpMigrationRunState) => void>()

function setState(next: PgpMigrationRunState): void {
	state = next
	for (const l of listeners) l(next)
}

export function getPgpMigrationState(): PgpMigrationRunState {
	return state
}

export function subscribePgpMigrationState(listener: (s: PgpMigrationRunState) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

function clearTimer(): void {
	if (timer !== undefined) clearTimeout(timer)
	timer = undefined
}

/** A late result event (after the page judged the request slow or timed out) is taken if its reqId is the latest request. */
function listenLate(): void {
	if (lateListening || typeof window === 'undefined') return
	lateListening = true
	const handler = (ev: Event) => {
		const p = eventPayloadOf(ev)
		if (!p || p.type !== 'pgpMigrateResult' || lastReqId === null || p.reqId !== lastReqId) return
		if (decided) return
		const next = pageStateForDecision(interpretPgpMigrateEvent(p, lastReqId))
		if (!next) return
		publishNativePwaLog('info', `[pgpMigrate] a late result is taken: ${next}`)
		if (DECISIVE.includes(next)) {
			decided = true
			clearTimer()
		}
		setState(next)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, handler)
}

async function attempt(reason: string): Promise<void> {
	if (decided || inFlight) return
	inFlight = true
	listenLate()
	setState('running')
	const reqId = nextReqId()
	lastReqId = reqId
	let result: MigrationPageState
	try {
		result = await runPgpMigration({
			reqId,
			send: async (cmd) => {
				const answer = await requestNativeAck(cmd, TIMEOUT_MS, reqId)
				return answer.kind === 'payload' ? answer.payload : null
			},
			subscribe: (onEvent) => {
				const listener = (ev: Event) => {
					const payload = eventPayloadOf(ev)
					if (payload && payload.type === 'pgpMigrateResult') onEvent(payload)
				}
				for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
				return () => {
					for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
				}
			},
			timeoutMs: TIMEOUT_MS,
		})
	} finally {
		inFlight = false
	}
	// a late result may have settled the run while this one was waiting
	if (decided) return
	publishNativePwaLog('info', `[pgpMigrate] ${reason}: ${result}`)
	if (DECISIVE.includes(result)) {
		decided = true
		clearTimer()
		backoff.reset('pgpMigrate')
		setState(result)
		return
	}
	if (result === 'not_ready' || result === 'retryable') {
		// unknown: asked again after this answer, on the cold-start schedule; not final, so `started` stays unset
		setState(result === 'retryable' ? 'retryable' : 'not_ready')
		scheduleNext()
		return
	}
	setState(result)
}

function scheduleNext(): void {
	if (decided || inFlight || timer !== undefined) return
	const step = backoff.next('pgpMigrate')
	if (step.kind === 'exhausted') {
		publishNativePwaLog('warn', `[pgpMigrate] the 180 s window is used up after ${step.attempt} attempts (${step.elapsedMs} ms): events and the visible poll go on`)
		return
	}
	publishNativePwaLog('info', `[pgpMigrate] attempt ${step.attempt} in ${step.delayMs} ms, ${step.elapsedMs} ms since the first`)
	timer = setTimeout(() => {
		timer = undefined
		void attempt('backoff')
	}, step.delayMs)
}

/** Starts the migration for this session. A second call while it runs, or after a decisive result, does nothing. */
export async function startPgpMigrationOnce(): Promise<void> {
	if (decided || inFlight) return
	await attempt('start')
}

export type PgpMigrateEvent = 'identity_ready' | 'chat_started' | 'foreground' | 'first_identity_done' | 'account_switch' | 'poll'

/**
 * The page events that ask again. After the backoff window is used up each of identity_ready, chat_started and foreground sends one more
 * request (once each); `poll` (the visible 30 s read) always may. A no_key state is asked again once after identity_ready,
 * first_identity_done or account_switch. A decisive result, or a request in flight, makes it do nothing.
 */
export function notifyPgpMigrateEvent(event: PgpMigrateEvent): void {
	if (decided || inFlight) return
	if (state === 'idle') return
	if (event === 'account_switch') {
		// another account: its own run
		backoff = createColdStartBackoff()
		resentFor.clear()
		noKeyRetried = false
		void attempt(event)
		return
	}
	if (state === 'unavailable') {
		if (!noKeyRetried && (event === 'identity_ready' || event === 'first_identity_done')) {
			noKeyRetried = true
			void attempt(event)
		}
		return
	}
	if (state !== 'not_ready' && state !== 'retryable') return
	if (event === 'poll') {
		void attempt(event)
		return
	}
	// inside the window the schedule already asks; after it, each event once
	if (timer !== undefined) return
	if (resentFor.has(event)) return
	resentFor.add(event)
	void attempt(event)
}

/** Test-only reset of the module state. */
export function resetPgpMigrationRunnerForTest(): void {
	clearTimer()
	state = 'idle'
	decided = false
	inFlight = false
	lastReqId = null
	backoff = createColdStartBackoff()
	resentFor.clear()
	noKeyRetried = false
	listeners.clear()
}
