/**
 * the outcome of ONE immediate write of the page record, as the chat needs it (a message must not leave the device without its record).
 *
 * 'committed' the record landed (the only success)
 * 'gate_closed' the page write gate refused the write
 * 'no_record' there is no record in memory: at the check, or inside the serial turn (the record can be gone by the time the turn comes)
 * 'write_failed' the write threw
 *
 * Only 'committed' is reported as written. The three others are failures: a "nothing to write" that is really "nothing was written" is never turned into success.
 * The dependencies are injected so the three failure kinds can each be injected in a test; beamio.ts supplies the real ones.
 */
export type DurableCommit = 'committed' | 'gate_closed' | 'no_record' | 'write_failed'

export interface DurableCommitDeps {
	/** Cancels the pending debounced write (this write takes its place). */
	cancelPendingTimer(): void
	/** The waiters of the debounced write: they ride on this write and hear its outcome. */
	takeWaiters(): Array<(stored: boolean) => void>
	gateOpen(): boolean
	hasRecord(): boolean
	runSerial<T>(task: () => Promise<T>): Promise<T>
	/** One write, run inside the serial turn: false when the record is gone at that point (nothing written), true when it landed; throws when the write failed. */
	writeSnapshot(): Promise<boolean>
}

export async function commitDurable(d: DurableCommitDeps): Promise<{ result: DurableCommit; error?: unknown }> {
	d.cancelPendingTimer()
	const waiters = d.takeWaiters()
	if (!d.gateOpen()) {
		waiters.forEach((done) => done(false))
		return { result: 'gate_closed' }
	}
	if (!d.hasRecord()) {
		waiters.forEach((done) => done(false))
		return { result: 'no_record' }
	}
	let committed = false
	try {
		committed = await d.runSerial(() => d.writeSnapshot())
	} catch (error) {
		waiters.forEach((done) => done(false))
		return { result: 'write_failed', error }
	}
	if (!committed) {
		waiters.forEach((done) => done(false))
		return { result: 'no_record' }
	}
	waiters.forEach((done) => done(true))
	return { result: 'committed' }
}

/**
 * The contract of flushStoreSystemData, which every other caller keeps: true when the record landed, false when nothing was written (gate closed or no record), and a thrown
 * error when the write failed. (Before, a closed gate or an absent record also resolved without a value; a caller that ignored the result sees no difference.)
 */
export function flushContract(outcome: { result: DurableCommit; error?: unknown }): boolean {
	if (outcome.result === 'write_failed') throw outcome.error
	return outcome.result === 'committed'
}

/** The error the chat raises for a write that did not land: the code names the case. */
export function durableCommitError(result: DurableCommit): Error | null {
	return result === 'committed' ? null : new Error(`persist_${result}`)
}
