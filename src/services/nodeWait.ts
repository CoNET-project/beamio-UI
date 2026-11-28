/**
 * the wait of a shell send for the entry nodes (the native chat start has not finished), as one small unit that can be tested with a virtual clock.
 *
 *  - A send that finds no nodes registers here (`wait`): the shell chat start is asked at once, and again every `reaskMs` while the nodes are missing; after `windowMs` the wait ends (`onExpire`: the
 *    message becomes "not sent, tap to retry" and the queue item is settled as failed, so the back-off and the heartbeat pick it up).
 *  - The nodes arriving (`nodesArrived`) deliver every waiting send at once: the wait entries are taken out first, then `deliver` runs for each. `deliver` is supplied by the page and goes through the queue's
 *    claim for a queued item (`SendQueue.run`), so it can never run at the same moment as a heartbeat or back-off attempt for the same sendId (single flight): no double POST.
 *  - `nudge` asks the shell chat start now when something waits and the nodes are still missing: the page calls it on `online` and `visible`, so those events do not wait for the next `reaskMs` tick.
 * The page's own wait is memory only: after a kill there is none, and the stored message is retried by the resume (sendResultMapping.ts resumeClassOf).
 */
export interface NodeWaiterOptions {
	windowMs: number
	reaskMs: number
	setTimer: (fn: () => void, ms: number) => unknown
	clearTimer: (h: unknown) => void
	/** the entry nodes are there (the native chat is ready) */
	nodesReady: () => boolean
	/** ask the shell chat start (the caller debounces) */
	askStart: () => void
	/** send the waiting message now (through the queue's claim for a queued item) */
	deliver: (id: string, wire: string, t0: number) => Promise<unknown>
	/** the window ran out */
	onExpire: (id: string, t0: number) => void
}

export interface NodeWaiter {
	wait(id: string, wire: string, t0: number): void
	has(id: string): boolean
	size(): number
	nodesArrived(): void
	nudge(): void
	dispose(): void
}

export function createNodeWaiter(o: NodeWaiterOptions): NodeWaiter {
	const entries = new Map<string, { wire: string; t0: number; timer: unknown }>()
	let reask: unknown = null
	let disposed = false

	const stopReask = () => {
		if (reask !== null) {
			o.clearTimer(reask)
			reask = null
		}
	}
	const startReask = () => {
		if (disposed || reask !== null || entries.size === 0) return
		reask = o.setTimer(() => {
			reask = null
			if (disposed || entries.size === 0) return
			if (!o.nodesReady()) o.askStart()
			startReask()
		}, o.reaskMs)
	}

	return {
		wait(id, wire, t0) {
			if (disposed) return
			const prev = entries.get(id)
			if (prev) o.clearTimer(prev.timer)
			const timer = o.setTimer(() => {
				const e = entries.get(id)
				if (!e) return
				entries.delete(id)
				if (entries.size === 0) stopReask()
				o.onExpire(id, e.t0)
			}, o.windowMs)
			entries.set(id, { wire, t0, timer })
			o.askStart()
			startReask()
		},
		has: (id) => entries.has(id),
		size: () => entries.size,
		nodesArrived() {
			if (disposed || entries.size === 0) return
			const taken = [...entries.entries()]
			entries.clear()
			stopReask()
			for (const [id, e] of taken) {
				o.clearTimer(e.timer)
				void o.deliver(id, e.wire, e.t0)
			}
		},
		nudge() {
			if (disposed || entries.size === 0 || o.nodesReady()) return
			o.askStart()
		},
		dispose() {
			disposed = true
			for (const e of entries.values()) o.clearTimer(e.timer)
			entries.clear()
			stopReask()
		},
	}
}
