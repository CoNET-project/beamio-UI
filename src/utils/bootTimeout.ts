/**
 * Bounded waits on the App's start path. A stalled call (a hung server, a dead socket, a stuck RPC) must not hold the start:
 * after the bound the caller takes its existing failure path and goes on. The stalled work is not cancelled by `withBootTimeout`; its
 * late result is ignored once the fallback is taken.
 */

/** Bound for one server request on the start path (headers and body). A timeout is an ordinary failed call. */
export const BOOT_REQUEST_TIMEOUT_MS = 12_000

/** Resolves to `fallback` after `ms`, and also when `work` rejects, so one failed side call never stops the start. */
export function withBootTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			() => {
				clearTimeout(timer)
				resolve(fallback)
			},
		)
	})
}

/**
 * An abort signal that fires after `ms`. Pass `signal` to fetch and call `done()` when the whole request (headers and body) has
 * finished, so the timer does not outlive it.
 */
export function abortAfter(ms: number): { signal: AbortSignal; done: () => void } {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	return { signal: ctrl.signal, done: () => clearTimeout(timer) }
}
