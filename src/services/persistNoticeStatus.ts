/**
 * 0.53.39: the state of a save that did not complete (the record was refused or could not be written). It holds
 * only a flag and a retry callback; it never holds the record or any secret. The notice is shown by the existing ShellSyncNotice position.
 */
import { useSyncExternalStore } from 'react'

let failed = false
let retryFn: (() => void) | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
	listeners.forEach((l) => l())
}

/** The save did not complete: the data on disk is unchanged. */
export function setPersistFailed(): void {
	if (failed) return
	failed = true
	emit()
}

/** The save completed: the notice goes away. */
export function clearPersistFailed(): void {
	if (!failed) return
	failed = false
	emit()
}

export function isPersistFailed(): boolean {
	return failed
}

/** The writer registers how to save again (the same debounced write). Null when nothing can retry. */
export function setPersistRetry(fn: (() => void) | null): void {
	retryFn = fn
}

/** Runs the registered retry. Returns false when none is registered. */
export function retryPersist(): boolean {
	if (!retryFn) return false
	try {
		retryFn()
	} catch {
		return false
	}
	return true
}

export function subscribePersistNotice(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** For tests: back to the start state. */
export function resetPersistNotice(): void {
	failed = false
	retryFn = null
	emit()
}

export function usePersistNoticeFailed(): boolean {
	return useSyncExternalStore(subscribePersistNotice, isPersistFailed, isPersistFailed)
}
