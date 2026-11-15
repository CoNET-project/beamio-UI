/**
 * The shell's "temporarily unavailable" state of the PGP source (temporary): the chat shows a dedicated
 * message and retries on the 30 s, 2 min, 10 min ladder. When the ladder is spent the retries stop and the notice offers a manual
 * retry. It is not "no PGP", not a rebuild, and not a terminal state. It is cleared when the start succeeds.
 */
export const PGP_TEMPORARY_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000]

/**
 * The delay before the next automatic retry, given the retries already made, or null when the ladder is spent (the retries stop; the notice
 * offers a manual retry).
 */
export function nextPgpTemporaryDelay(retriesMade: number): number | null {
	if (retriesMade < 0) return PGP_TEMPORARY_RETRY_DELAYS_MS[0]
	if (retriesMade >= PGP_TEMPORARY_RETRY_DELAYS_MS.length) return null
	return PGP_TEMPORARY_RETRY_DELAYS_MS[retriesMade]
}

let current = false
let stopped = false
const listeners = new Set<() => void>()

function notify(): void {
	for (const listener of [...listeners]) listener()
}

export function getShellPgpTemporary(): boolean {
	return current
}

/** True once the automatic retries have stopped for the temporary state; only a manual retry starts them again. */
export function getShellPgpTemporaryStopped(): boolean {
	return stopped
}

/** Sets or clears the temporary state. Setting it starts the ladder again; clearing it (the start succeeded) also clears the stopped flag. */
export function setShellPgpTemporary(value: boolean): void {
	if (value === current && (!value || !stopped)) return
	current = value
	stopped = false
	notify()
}

/** The ladder is spent: the notice stays with a manual retry. */
export function setShellPgpTemporaryStopped(value: boolean): void {
	if (value === stopped) return
	stopped = value
	notify()
}

export function subscribeShellPgpTemporary(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
