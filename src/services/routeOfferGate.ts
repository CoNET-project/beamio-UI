/**
 * Keeps the receipt-route offer from turning every inbound message into a fresh key read. One read per contact at a time (a second request for the same
 * contact joins the read already running) and a minimum time between two reads of the same contact. A change of the contact's key is still seen quickly:
 * every send and the periodic route refresh make their own trust decision, and the user's verification forces a read.
 */
export const ROUTE_OFFER_MIN_REREAD_MS = 3 * 60 * 1000
const MAX_TRACKED = 512

export type OfferGate = {
	/** Runs `task` for the contact unless it is running (join it) or was read less than the minimum ago (skip). `force`: read again after the running one. */
	run(address: string, task: () => Promise<void>, force?: boolean): Promise<void>
	reset(): void
}

export function createOfferGate(now: () => number = Date.now, minRereadMs: number = ROUTE_OFFER_MIN_REREAD_MS): OfferGate {
	const lastReadAt = new Map<string, number>()
	const inFlight = new Map<string, Promise<void>>()
	const start = (a: string, task: () => Promise<void>): Promise<void> => {
		lastReadAt.set(a, now())
		if (lastReadAt.size > MAX_TRACKED) lastReadAt.delete(lastReadAt.keys().next().value as string)
		const p = task().then(
			() => undefined,
			() => undefined,
		).finally(() => {
			if (inFlight.get(a) === p) inFlight.delete(a)
		})
		inFlight.set(a, p)
		return p
	}
	return {
		run(address, task, force = false) {
			const a = String(address ?? '').trim().toLowerCase()
			if (!a) return Promise.resolve()
			const running = inFlight.get(a)
			if (running) return force ? running.then(() => start(a, task)) : running
			const last = lastReadAt.get(a)
			if (!force && last !== undefined && now() - last < minRereadMs) return Promise.resolve()
			return start(a, task)
		},
		reset() {
			lastReadAt.clear()
			inFlight.clear()
		},
	}
}

/** The page's one gate for the receipt-route offer. It is cleared together with the route table on an account change and on an identity clear. */
export const sharedOfferGate: OfferGate = createOfferGate()
