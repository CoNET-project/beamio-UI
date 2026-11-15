/**
 * Store step of one inbound batch.
 *
 * The order is fixed here so it can be tested without the page:
 *   1. browser only: the armor hashes of every line in the batch get dedupe markers (the new rows and the dropped lines);
 *   2. the store commit runs;
 *   3a. the commit failed: markers added in step 1 are rolled back; nothing is acked, nothing is released;
 *   3b. the commit succeeded: the pending entries are released, then
 *       - browser: the mailbox ACK for every line (rows, duplicate copies and dropped lines), after the commit;
 *       - native: `ackInbound` for the hashes of new rows, and for a duplicate copy only when no `ackInbound` was ever sent for its hash
 * Dropped lines (control, non-chat, parse failure) are never passed on, so they get no `ackInbound`and no sender
 * receipt.
 *
 * `target` is captured by the caller at store time (the client and the capability), so a later change of the active client does not
 * redirect the ACK.
 */
export type InboundAckTarget = {
	/** True when the page acks the mailbox itself (browser TS Worker). */
	browser: boolean
	/**
	 * Native: true when `ackInbound`was already issued for this armor hash in this page session. The target records it
	 * when the call is actually made (see issueInboundAck), never before.
	 */
	alreadyAcked: (armorHash: string) => boolean
	/** Browser: mailbox ACK for these armor hashes. Called only after a successful commit. */
	ackMailbox: (armorHashes: string[]) => void
	/** Native: `ackInbound` for these armor hashes. Called only after a successful commit. */
	ackDisplayed: (armorHashes: string[]) => void
}

export type InboundBatchInput = {
	/** Lines whose chat row this batch wrote. */
	rowLines: readonly string[]
	/** Lines whose chat row was already in the store (duplicate copies). */
	duplicateLines?: readonly string[]
	/** Lines consumed without a row: voice control, delivery receipt, non-chat, bad signature, parse failure, duplicate copy. */
	dropLines: readonly string[]
}

export type InboundBatchSettleDeps = {
	target: InboundAckTarget
	/** Armor hashes of these lines. No side effects. */
	hashesOf: (lines: readonly string[]) => string[]
	/** Writes dedupe markers for these armor hashes; returns the ones that were not marked before. */
	markHashes: (armorHashes: string[]) => string[]
	/** Removes markers this batch added (failed commit). */
	unmarkHashes: (armorHashes: string[]) => void
	/** Store commit. Resolves true only when the write has landed. */
	commit: () => Promise<boolean>
	/** Drops the pending entries of these lines after a successful commit. */
	release: (lines: readonly string[]) => void
}

const unique = (hashes: readonly string[]): string[] => [...new Set(hashes)]

/** Resolves true when the batch was committed (and the ACK, if any, was handed to `target`). False when the commit failed. */
export async function settleInboundBatch(input: InboundBatchInput, deps: InboundBatchSettleDeps): Promise<boolean> {
	const rowHashes = unique(deps.hashesOf(input.rowLines))
	const dupHashes = unique(deps.hashesOf(input.duplicateLines ?? []))
	const allHashes = unique([...rowHashes, ...dupHashes, ...deps.hashesOf(input.dropLines)])
	let added: string[] = []
	if (deps.target.browser && allHashes.length) added = deps.markHashes(allHashes)
	const stored = await deps.commit()
	if (!stored) {
		if (added.length) deps.unmarkHashes(added)
		return false
	}
	deps.release([...input.rowLines, ...(input.duplicateLines ?? []), ...input.dropLines])
	if (deps.target.browser) {
		if (allHashes.length) deps.target.ackMailbox(allHashes)
		return true
	}
	// Native: a duplicate copy is ACKed only when this hash was never ACKed before.
	const nativeHashes = unique([...rowHashes, ...dupHashes.filter((h) => !deps.target.alreadyAcked(h))])
	if (nativeHashes.length) deps.target.ackDisplayed(nativeHashes)
	return true
}

/**
 * Issues one native `ackInbound`and records the hashes as acked only when the call was actually made. No client
 * (null), or a call that throws: nothing is recorded, so a later copy is ACKed again. Returns true when the call was made.
 */
export function issueInboundAck(
	send: ((armorHashes: string[]) => void) | null,
	armorHashes: readonly string[],
	record: (armorHash: string) => void,
): boolean {
	if (!send || !armorHashes.length) return false
	try {
		send([...armorHashes])
	} catch {
		return false
	}
	armorHashes.forEach(record)
	return true
}

