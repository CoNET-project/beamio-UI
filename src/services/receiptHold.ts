/**
 * the bookkeeping of the receipt step of one inbound batch (receiptEvidence.ts, inboundBatchSettle.ts, App.tsx). Pure, in memory, no storage, no logging.
 *
 *  - ReceiptHoldStats: counters (numbers only) of what the step held and why; the hook variant prints them in its QA state line (`rh`). No sendId, no tag, no address.
 *  - UnreadableTracker: how long a queue document of one sendId has been unreadable while the key IS known (page memory, a reload starts again). Three readings in a row, or ten minutes since the first, make it
 *    PERMANENT. Permanent only COUNTS (and shows in the QA state line): the receipt is NOT written and the line is NOT ACKed (the product rule: the only way out of the queue is a receipt that binds
 *    the same message AND a safely stored local copy; a decryption failure never produces business success). The bad line stays pending and is retried with the back-off below, the rest of the batch goes on.
 *  - HeldLineTracker: how many times one mailbox line has been held, and when to put it into the normal path again (5 s, 15 s, 60 s, then 5 minutes at most).
 */
export interface ReceiptHoldStats {
	/** lines the step held (any reason) */
	held: number
	/** held because the browser has no key armor yet (transient) */
	heldNoKey: number
	/** held because the queue document is unreadable (every reading, permanent or not) */
	heldUnreadable: number
	/** held because the disk could not be read or the receipt document could not be written */
	heldDisk: number
	/** sendIds whose queue document turned PERMANENTLY unreadable (counted once per streak): still held, never written, never ACKed */
	permanent: number
	/** how many sendIds are PERMANENTLY unreadable right now (a gauge: the line of each is held and put back into the normal path every 5 minutes, for as long as the page lives) */
	permanentActive: number
}

export const newReceiptHoldStats = (): ReceiptHoldStats => ({ held: 0, heldNoKey: 0, heldUnreadable: 0, heldDisk: 0, permanent: 0, permanentActive: 0 })
/** the page-wide counters (read by the QA state line) */
export const receiptHoldStats: ReceiptHoldStats = newReceiptHoldStats()
export const receiptHoldStatsSnapshot = (): ReceiptHoldStats => ({ ...receiptHoldStats })
export const resetReceiptHoldStatsForTest = (): void => { Object.assign(receiptHoldStats, newReceiptHoldStats()) }

export const UNREADABLE_PERMANENT_READINGS = 3
export const UNREADABLE_PERMANENT_MS = 10 * 60 * 1000

export interface UnreadableTracker {
	/** one more unreadable reading of this sendId; says whether it is permanent now and whether this very reading made it so (counted once per streak) */
	note(sendId: string): { count: number; permanent: boolean; becamePermanent: boolean }
	/** a readable or absent reading, or a written receipt: the streak is over */
	clear(sendId: string): void
	size(): number
	/** how many tracked sendIds are permanently unreadable now */
	permanentCount(): number
}

export function createUnreadableTracker(now: () => number = () => Date.now()): UnreadableTracker {
	const streaks = new Map<string, { count: number; firstAt: number; flagged?: boolean }>()
	return {
		note: (sendId) => {
			const t = now()
			const s = streaks.get(sendId) ?? { count: 0, firstAt: t }
			s.count += 1
			streaks.set(sendId, s)
			if (streaks.size > 1000) {
				const oldest = streaks.keys().next().value
				if (oldest !== undefined && oldest !== sendId) streaks.delete(oldest)
			}
			const permanent = s.count >= UNREADABLE_PERMANENT_READINGS || t - s.firstAt >= UNREADABLE_PERMANENT_MS
			const becamePermanent = permanent && !s.flagged
			if (permanent) s.flagged = true
			return { count: s.count, permanent, becamePermanent }
		},
		clear: (sendId) => { streaks.delete(sendId) },
		size: () => streaks.size,
		permanentCount: () => { let n = 0; for (const s of streaks.values()) if (s.flagged) n += 1; return n },
	}
}

export const HELD_LINE_STEPS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000]
export const heldLineDelayMs = (attempt: number): number => HELD_LINE_STEPS_MS[Math.min(Math.max(1, attempt), HELD_LINE_STEPS_MS.length) - 1]

export interface HeldLineTracker {
	/** this line is held once more: which attempt it is and when to put it back into the normal path */
	hold(line: string): { attempt: number; delayMs: number }
	clear(line: string): void
	size(): number
}

export function createHeldLineTracker(): HeldLineTracker {
	const attempts = new Map<string, number>()
	return {
		hold: (line) => {
			const attempt = (attempts.get(line) ?? 0) + 1
			attempts.set(line, attempt)
			if (attempts.size > 500) {
				const oldest = attempts.keys().next().value
				if (oldest !== undefined && oldest !== line) attempts.delete(oldest)
			}
			return { attempt, delayMs: heldLineDelayMs(attempt) }
		},
		clear: (line) => { attempts.delete(line) },
		size: () => attempts.size,
	}
}
