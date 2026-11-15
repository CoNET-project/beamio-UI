/**
 * PGP migration runner (the default proposal): runs once per shell session after the wallet is ready, in the background.
 * It sends `pgpMigrate` over the native channel and keeps the page state in memory. It never generates a key, never clears a
 * record, and shows nothing by itself: the Chat page reads `getPgpMigrationState()` (the copy for a visible state needs the
 * project owner's approval).
 */
import { requestNativeAck, nextReqId } from './nativeChatRouteRegister'
import { NATIVE_EVENT_NAMES, eventPayloadOf } from './nativeKeyState'
import { runPgpMigration, type MigrationPageState } from './pgpMigrationClient'

export type PgpMigrationRunState = 'idle' | 'running' | MigrationPageState

// a real interruption sends no event (checkpoint always continues in production); the page times out and sends again.
const TIMEOUT_MS = 60000
let state: PgpMigrationRunState = 'idle'
let started = false
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

/** Starts one migration run for this shell session. A second call while started does nothing. */
export async function startPgpMigrationOnce(): Promise<void> {
	if (started) return
	started = true
	setState('running')
	const reqId = nextReqId()
	const result = await runPgpMigration({
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
	setState(result)
	// A run that did not finish (retryable) may be started again by the next shell start; the page never replaces a key.
}

/** Test-only reset of the module state. */
export function resetPgpMigrationRunnerForTest(): void {
	state = 'idle'
	started = false
	listeners.clear()
}
