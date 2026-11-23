/**
 * 2026-11-22 (the decision, item 2): every native read of the start is capped. A read that does not answer within the cap
 * is a timeout (a diagnostic line with the reqId only); the task keeps running and its answer is handed back to the caller, which decides
 * by reqId whether it is still wanted. The cap is 30 seconds; the setter exists only so that tests can run the timeout in real time.
 */
export const NATIVE_READ_CAP_MS = 30_000
let capMs = NATIVE_READ_CAP_MS

export const nativeReadCapMs = (): number => capMs

/** Test-only: shortens the cap (production never calls this; null restores 30 seconds). */
export function setNativeReadCapMsForTest(ms: number | null): void {
	capMs = ms ?? NATIVE_READ_CAP_MS
}

export type CappedRead<T> = { kind: 'answer'; value: T } | { kind: 'timeout' }

/** Races one native read against the cap. The task itself is not cancelled. */
export function capNativeRead<T>(task: Promise<T>): Promise<CappedRead<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<CappedRead<T>>((resolve) => {
		timer = setTimeout(() => resolve({ kind: 'timeout' }), capMs)
	})
	const answer = task.then((value): CappedRead<T> => ({ kind: 'answer', value }))
	return Promise.race([answer, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer)
	})
}
