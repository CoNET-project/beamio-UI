/**
 * r94: the home's view of the page-to-shell sync (`pwaWalletSync`). It holds only a state, a reason code and a retry callback.
 * It never holds the mnemonic, the EOA or any record value, and it never clears local data: a failure keeps the old data and the home.
 */
import { useSyncExternalStore } from 'react'

export type ShellSyncCode = 'write_failed' | 'stale_seq' | 'untrusted_source' | 'key_over_bridge_refused' | 'bad_request' | 'no_answer' | 'locked' | 'unlock_failed' | 'verify_failed'

export type ShellSyncState =
	| { kind: 'idle' }
	| { kind: 'syncing' }
	| { kind: 'synced' }
	/** A sync that did not finish. `retryable` is true for transient codes (a write that failed, no answer). */
	| { kind: 'failed'; code: ShellSyncCode; retryable: boolean; reason?: string }

const IDLE: ShellSyncState = { kind: 'idle' }
let state: ShellSyncState = IDLE
let retryFn: (() => void) | null = null
const listeners = new Set<() => void>()

function emit(next: ShellSyncState) {
	state = next
	listeners.forEach((l) => l())
}

export function getShellSyncState(): ShellSyncState {
	return state
}

export function setShellSyncState(next: ShellSyncState): void {
	emit(next)
}

/** The gate registers the retry (it re-reads the page's valid mnemonic and syncs again). Null when nothing can retry. */
export function setShellSyncRetry(fn: (() => void) | null): void {
	retryFn = fn
}

/** Runs the registered retry. Returns false when none is registered. Never throws into the caller. */
export function retryShellSync(): boolean {
	// a sync in flight is not stacked: a retry while one runs is a no-op
	if (!retryFn || state.kind === 'syncing') return false
	try {
		retryFn()
	} catch {
		return false
	}
	return true
}

export function subscribeShellSync(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** For tests: back to the start state with no retry. */
export function resetShellSyncStatus(): void {
	retryFn = null
	manualCheckFn = null
	emit(IDLE)
}

/** The current state for a component. */
export function useShellSyncState(): ShellSyncState {
	return useSyncExternalStore(subscribeShellSync, getShellSyncState, getShellSyncState)
}

/** v10 §六.2: the gate registers the live check for the manual retry button (the rule is pure; the inputs are read here). */
let manualCheckFn: (() => Promise<boolean>) | null = null
export function setShellSyncManualCheck(fn: (() => Promise<boolean>) | null): void {
	manualCheckFn = fn
}
/** Whether the manual retry may be shown now. False when nothing is registered. Never throws. */
export async function checkShellManualRetry(): Promise<boolean> {
	if (!manualCheckFn) return false
	try {
		return await manualCheckFn()
	} catch {
		return false
	}
}
