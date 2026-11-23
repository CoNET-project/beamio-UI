/**
 * When the encrypted history is loaded (the replay plan).
 *
 * - single-flight: a request that arrives while a load runs is covered by it; a bypass request that arrives during a load runs once more
 *   after it ("dirty").
 * - minimum interval: after a load, a request from an ordinary caller is skipped until the interval has passed. The interval is
 * HISTORY_LOAD_MIN_INTERVAL_MS, an engineering default (not a project decision). A skipped request gets one trailing run when the
 * interval has passed, so it is not lost; several skipped requests share that one run.
 * - bypass callers: the account changed (historyEoa_change) and the foreground resume (foreground_resume) run at once.
 * - every load logs one line with the caller and numbers only: the time taken and the number of entries the history buffer delivered
 *   during the load. No content and no address.
 */

export type HistoryLoadCaller = 'historyEoa_change' | 'foreground_resume' | 'listen_start' | 'other'

/** Engineering default for the minimum interval between loads. Configurable through createHistoryLoadGate. */
export const HISTORY_LOAD_MIN_INTERVAL_MS = 30_000

const BYPASS_CALLERS: ReadonlySet<HistoryLoadCaller> = new Set(['historyEoa_change', 'foreground_resume'])

/** The stronger of two callers: a bypass caller wins, so a queued ordinary request never hides an account change. */
export const strongerHistoryCaller = (a: HistoryLoadCaller, b: HistoryLoadCaller): HistoryLoadCaller => {
	if (BYPASS_CALLERS.has(a)) return a
	if (BYPASS_CALLERS.has(b)) return b
	return a
}

export interface HistoryLoadGateOptions {
	minIntervalMs?: number
	now?: () => number
	log?: (line: string) => void
	/** Schedules the trailing run of a skipped request. Defaults to setTimeout. */
	schedule?: (fn: () => void, ms: number) => void
}

export interface HistoryLoadGate {
	/** Runs `load` unless the request is covered (single-flight) or skipped (interval). Resolves when the request is covered. */
	request(caller: HistoryLoadCaller, load: () => Promise<void>): Promise<void>
	/** Counts the entries the history buffer delivered. Only the number is kept, and only while a load runs. */
	noteDelivered(count: number): void
	/** For tests and inspection. */
	state(): { inFlight: boolean; dirty: boolean; lastDoneAt: number | null; trailing: boolean }
	/**
	 * A new worker client starts: its loads are not covered by a load of the old client, and the interval does not hold them back.
	 * A load still running for the old client finishes without changing the state of the new one.
	 */
	reset(): void
}

export function createHistoryLoadGate(options: HistoryLoadGateOptions = {}): HistoryLoadGate {
	const minIntervalMs = options.minIntervalMs ?? HISTORY_LOAD_MIN_INTERVAL_MS
	const now = options.now ?? (() => Date.now())
	const log = options.log ?? ((line: string) => console.info(line))
	const schedule = options.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms))
	let inFlight: Promise<void> | null = null
	let inFlightCaller: HistoryLoadCaller | null = null
	let dirtyCaller: HistoryLoadCaller | null = null
	/** The load the dirty re-run runs (a skipped request whose timer fired during a load keeps its own load). */
	let dirtyLoad: (() => Promise<void>) | null = null
	let lastDoneAt: number | null = null
	let delivered = 0
	let loading = false
	/** the skipped ordinary request that runs once the interval has passed (one timer, the stronger caller). */
	let trailing: { caller: HistoryLoadCaller; load: () => Promise<void> } | null = null
	let trailingTimer = false
	/** Bumped by reset(): a job that started before the reset does not change the state of the newer generation. */
	let generation = 0

	const run = (caller: HistoryLoadCaller, load: () => Promise<void>): Promise<void> => {
		const started = now()
		const myGeneration = generation
		delivered = 0
		loading = true
		inFlightCaller = caller
		const job = (async () => {
			try {
				await load()
			} catch {
				/* the SDK load reports its own failure; the gate only times it */
			}
			const done = now()
			if (myGeneration === generation) {
				loading = false
				lastDoneAt = done
			}
			log(`[history] load caller=${caller} ms=${done - started} delivered=${delivered}`)
		})()
		inFlight = job.then(async () => {
			if (myGeneration !== generation) return
			inFlight = null
			inFlightCaller = null
			if (dirtyCaller !== null) {
				const again = dirtyCaller
				const againLoad = dirtyLoad ?? load
				dirtyCaller = null
				dirtyLoad = null
				await request(again, againLoad)
			}
		})
		return inFlight
	}

	/** Records a re-run after the load in flight. The stronger caller wins, and its load is the one that runs. */
	const setDirty = (caller: HistoryLoadCaller, load: () => Promise<void>): void => {
		if (dirtyCaller === null) {
			dirtyCaller = caller
			dirtyLoad = load
			return
		}
		const stronger = strongerHistoryCaller(dirtyCaller, caller)
		if (stronger === caller && stronger !== dirtyCaller) dirtyLoad = load
		dirtyCaller = stronger
	}

	const request = (caller: HistoryLoadCaller, load: () => Promise<void>): Promise<void> => {
		if (inFlight) {
			// A bypass request for a different reason may have new data behind it: it runs once more after this load. The same reason
			// is already covered by the load in flight.
			if (BYPASS_CALLERS.has(caller) && caller !== inFlightCaller) setDirty(caller, load)
			return inFlight
		}
		if (!BYPASS_CALLERS.has(caller) && lastDoneAt !== null && now() - lastDoneAt < minIntervalMs) {
			log(`[history] skip caller=${caller} reason=interval`)
			// the skipped request is not lost. One trailing run after the interval covers it.
			trailing = trailing ? { caller: strongerHistoryCaller(trailing.caller, caller), load } : { caller, load }
			if (!trailingTimer) {
				trailingTimer = true
				const myGeneration = generation
				schedule(
					() => {
						// a timer of the client before a reset does not run on the new one.
						if (myGeneration !== generation) return
						trailingTimer = false
						const t = trailing
						trailing = null
						if (!t) return
						// a load is running when the timer fires. The skipped request is not dropped: it runs after that load.
						if (inFlight !== null) {
							setDirty(t.caller, t.load)
							return
						}
						void request(t.caller, t.load)
					},
					Math.max(0, minIntervalMs - (now() - lastDoneAt)),
				)
			}
			return Promise.resolve()
		}
		return run(caller, load)
	}

	return {
		request,
		noteDelivered(count: number) {
			if (loading && Number.isFinite(count) && count > 0) delivered += Math.floor(count)
		},
		state() {
			return { inFlight: inFlight !== null, dirty: dirtyCaller !== null, lastDoneAt, trailing: trailing !== null }
		},
		reset() {
			generation += 1
			trailing = null
			trailingTimer = false
			inFlight = null
			inFlightCaller = null
			dirtyCaller = null
			dirtyLoad = null
			loading = false
			lastDoneAt = null
			delivered = 0
		},
	}
}
