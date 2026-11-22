/**
 * The worker ready watchdog (the gossip worker start, before its `ready`). The ready-phase timers of gossip-core (sign 20 s, wrap 10 s) start
 * only after `ready`, so a start that never reaches `ready` needs its own bound. The watchdog names the page-side step where the start
 * stopped: worker_created, nodes_loaded, init_sent (the worker has not answered init). A worker that has not answered init may be stuck in
 * its own init (makeGossip, makeHistory, gossip.init): the page cannot see inside the worker, so the step names the wait, not the cause.
 */
export const WORKER_READY_TIMEOUT_MS = 30_000
export const WORKER_READY_TIMEOUT = 'worker_ready_timeout'

export class WorkerReadyTimeout extends Error {
	constructor(readonly step: string) {
		super(WORKER_READY_TIMEOUT)
		this.name = 'WorkerReadyTimeout'
	}
}

/** Rejects with WorkerReadyTimeout(step) when `p` has not settled within `ms`. The step is read when the watchdog fires. */
export function withWorkerReadyWatchdog<T>(p: Promise<T>, getStep: () => string, ms: number = WORKER_READY_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new WorkerReadyTimeout(getStep())), ms)
		}),
	]).finally(() => clearTimeout(timer))
}
