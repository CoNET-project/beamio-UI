/**
 * Network gate for repeating chat probes (peer online, native wake, BeamioTag).
 *
 * 2026-11-11 airplane-mode test (Samsung S25 Ultra): the open thread kept
 * probing every 6 s and the BeamioTag batch fired about 25 probes in 1.5 s,
 * all failing at the native post with "no reachable entry left". They used up
 * the native entry service's probe budget, so the re-probe after the network
 * came back was held back.
 *
 * Rules here:
 * - Offline (navigator.onLine false): send nothing; wait for the `online` event.
 * - Probes that get no trusted reply in a row back off (6 → 12 → 24 → 48 → 60 s).
 *   This also covers a WebView that never reports offline.
 * - When the network comes back, start again after a random delay, so the
 *   loops do not all fire in the same instant.
 */

export type NetworkSource = {
	/** False only when the browser or shell says there is no network. */
	isOnline(): boolean
	/** Calls `cb` when the network comes back. Returns an unsubscribe. */
	onOnline(cb: () => void): () => void
}

export const browserNetworkSource: NetworkSource = {
	isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
	onOnline: (cb) => {
		if (typeof window === 'undefined') return () => {}
		window.addEventListener('online', cb)
		return () => window.removeEventListener('online', cb)
	},
}

/**
 * Delay before the next probe after `failures` probes in a row with no
 * trusted reply. One failure keeps the normal pace (a short blip).
 */
export function presenceDelayMs(failures: number, baseMs: number, maxMs: number): number {
	if (failures <= 1) return baseMs
	return Math.min(maxMs, baseMs * 2 ** (failures - 1))
}

/** A random delay in [minMs, maxMs). */
export function recoveryJitterMs(minMs: number, maxMs: number, random: () => number = Math.random): number {
	const span = Math.max(0, maxMs - minMs)
	return Math.floor(minMs + random() * span)
}

type TimerFns = {
	setTimer?: (cb: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}

export type NetworkAwareLoopOptions = TimerFns & {
	/** One probe round. True when at least one trusted reply came back. */
	probe: () => Promise<boolean>
	intervalMs: number
	maxBackoffMs: number
	/** Random first delay after the network comes back. */
	recoveryMinMs: number
	recoveryMaxMs: number
	net?: NetworkSource
	random?: () => number
	/** Called when the loop pauses for no network (for the log). */
	onPause?: () => void
	/** Called with the delay when the network comes back (for the log). */
	onResume?: (delayMs: number) => void
}

/**
 * Runs `probe` now and then every `intervalMs`, paused while offline and
 * backed off while probes fail. Returns stop().
 */
export function startNetworkAwareLoop(opts: NetworkAwareLoopOptions): () => void {
	const net = opts.net ?? browserNetworkSource
	const random = opts.random ?? Math.random
	const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
	const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

	let stopped = false
	let timer: unknown
	let inFlight = false
	let paused = false
	let failures = 0

	const clear = () => {
		if (timer !== undefined) clearTimer(timer)
		timer = undefined
	}

	const schedule = (ms: number) => {
		clear()
		if (stopped) return
		timer = setTimer(() => {
			timer = undefined
			void run()
		}, ms)
	}

	const run = async () => {
		if (stopped || inFlight) return
		if (!net.isOnline()) {
			if (!paused) {
				paused = true
				opts.onPause?.()
			}
			return
		}
		paused = false
		inFlight = true
		let ok = false
		try {
			ok = await opts.probe()
		} catch {
			ok = false
		} finally {
			inFlight = false
		}
		if (stopped) return
		failures = ok ? 0 : failures + 1
		if (!net.isOnline()) {
			if (!paused) {
				paused = true
				opts.onPause?.()
			}
			return
		}
		schedule(presenceDelayMs(failures, opts.intervalMs, opts.maxBackoffMs))
	}

	const unsubscribe = net.onOnline(() => {
		if (stopped) return
		failures = 0
		paused = false
		// A probe in flight reschedules itself at the normal pace.
		if (inFlight) return
		const delay = recoveryJitterMs(opts.recoveryMinMs, opts.recoveryMaxMs, random)
		opts.onResume?.(delay)
		schedule(delay)
	})

	void run()

	return () => {
		stopped = true
		clear()
		unsubscribe()
	}
}
