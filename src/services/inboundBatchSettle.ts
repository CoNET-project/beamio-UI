/**
 * Store step of one inbound batch.
 *
 * The order is fixed here so it can be tested without the page:
 *   0. the delivery receipts of this batch are written to their own documents (receiptEvidence.ts) BEFORE any dedupe marker is set and before the commit. The step answers ROW BY ROW: the lines it HOLDS
 *      (their receipt could not be kept) get no marker, no release and no ACK, on either path, and are handed to `onHeld` (the caller puts them into the normal path again with a back-off). Every other line of the
 *      batch goes on as below: one bad receipt no longer holds back the marker, the commit and the ACK of the other lines. (A marker lives in the account record, which another writer can carry to disk: a marker that
 *      outlived a receipt that was never written would lose the positive evidence for good; that is why a held line never gets one.) A step that throws holds `receiptLines`, or every drop line when none were given.
 *   1. browser only: the armor hashes of every line in the batch get dedupe markers (the new rows and the dropped lines), EXCEPT the new rows whose ACK waits for the history append: their marker
 *      is set after the append is confirmed, right before the ACK (inboundDurable.ts);
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
import { isDurablePending, startDurableAck, type DurableMirror, type DurableOptions } from './inboundDurable'
import { qaEvent } from '../utils/qaAckOrder'

/** the last 8 hex digits of an armor hash, as a code word for the hook events ('h' + 8 hex) */
const shortHash = (hash: string | undefined): string => `h${String(hash ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(-8)}`

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
	/** Native: `ackInbound` for these armor hashes. Called only after a successful commit (and, when nativeAckAfterAppend, only after the history append of the line returned ok). */
	ackDisplayed: (armorHashes: string[]) => void
	/**
	 * native shell that declares `inbound.deferAck`: the `ackInbound` of a message line (new row or duplicate copy, with or without a sendId) waits for its `historyAppend` result, through the
	 * same wait as the browser (inboundDurable.ts); a failure or a timeout sends nothing and asks again. Lines that are not written to history (receipts, call signalling, drafts, any dropped line) keep the old native
	 * behaviour: this step never sends `ackInbound` for them.
	 */
	nativeAckAfterAppend?: boolean
}

export type InboundBatchInput = {
	/** Lines whose chat row this batch wrote. */
	rowLines: readonly string[]
	/** Lines whose chat row was already in the store (duplicate copies). */
	duplicateLines?: readonly string[]
	/** Lines consumed without a row: voice control, delivery receipt, non-chat, bad signature, parse failure, duplicate copy. */
	dropLines: readonly string[]
	/** the lines that carry a delivery receipt (a subset of dropLines): what is held when the receipt step itself throws */
	receiptLines?: readonly string[]
	/**
	 * +, browser only: the message lines (rows and duplicate copies) whose mailbox ACK waits for the history append: line -> that line's append (inboundDurable.ts). Their ACK is NOT sent here: it is sent by the
	 * background wait after the worker confirmed the append, with a back-off retry when it did not. A message line WITHOUT an entry here is never ACKed by this step (the mailbox sends it again).
	 */
	durable?: ReadonlyMap<string, DurableMirror>
}

/** the answer of the receipt step: the mailbox lines whose receipt evidence is NOT on disk */
export type ReceiptStepOutcome = { heldLines: readonly string[] }

export type InboundBatchSettleDeps = {
	target: InboundAckTarget
	/** Armor hashes of these lines. No side effects. */
	hashesOf: (lines: readonly string[]) => string[]
	/** Writes dedupe markers for these armor hashes; returns the ones that were not marked before. */
	markHashes: (armorHashes: string[]) => string[]
	/** Removes markers this batch added (failed commit). */
	unmarkHashes: (armorHashes: string[]) => void
	/** writes the receipt documents of this batch (receiptEvidence.ts persistReceiptEvidence) and says which lines it holds. Absent: nothing to write. */
	persistReceipts?: () => Promise<ReceiptStepOutcome>
	/** the lines held back by the receipt step (called once, before the commit) */
	onHeld?: (lines: readonly string[]) => void
	/** Store commit. Resolves true only when the write has landed. */
	commit: () => Promise<boolean>
	/** Drops the pending entries of these lines after a successful commit. */
	release: (lines: readonly string[]) => void
	/** timing of the wait for the history append (tests inject a clock); defaults in inboundDurable.ts */
	durableOptions?: DurableOptions
}

const unique = (hashes: readonly string[]): string[] => [...new Set(hashes)]

/** Resolves true when the batch was committed (and the ACK, if any, was handed to `target`). False when the commit failed. */
export async function settleInboundBatch(input: InboundBatchInput, deps: InboundBatchSettleDeps): Promise<boolean> {
	let held = new Set<string>()
	if (deps.persistReceipts) {
		try {
			held = new Set((await deps.persistReceipts()).heldLines)
		} catch {
			held = new Set(input.receiptLines ?? input.dropLines) // the step itself failed: nothing is known about any receipt line
		}
		if (held.size) {
			try { deps.onHeld?.([...held]) } catch { /* the lines stay held either way */ }
		}
	}
	const keep = (lines: readonly string[]): string[] => (held.size ? lines.filter((l) => !held.has(l)) : [...lines])
	const rowLines = keep(input.rowLines)
	const duplicateLines = keep(input.duplicateLines ?? [])
	const dropLines = keep(input.dropLines)
	// a held line's armor hash is never marked or ACKed, even when another line of the batch carries the same armor
	const heldHashes = new Set(held.size ? deps.hashesOf([...held]) : [])
	const free = (hashes: string[]): string[] => (heldHashes.size ? hashes.filter((h) => !heldHashes.has(h)) : hashes)
	const rowHashes = free(unique(deps.hashesOf(rowLines)))
	const dupHashes = free(unique(deps.hashesOf(duplicateLines)))
	const browser = deps.target.browser
	// in the BROWSER only a DROPPED line (a delivery receipt, a control line, a non-chat line, a parse failure: nothing to keep) may be ACKed by this step. A message row, a duplicate copy
	// of a row and a replayed row are ACKed ONLY by the wait for their history append (inboundDurable.ts), after the append is confirmed. So no upstream branch (a replay batch, a duplicate, a mirror that
	// returned nothing) can release a message line early: a row with no append to wait for is simply not ACKed and the mailbox sends it again; the page de-duplicates by sendId.
	// A hash shared between a drop line and a row / duplicate line of the same batch counts as a row (the exclusion is by hash, not by line).
	const rowOrDup = new Set([...rowHashes, ...dupHashes])
	// The hashes of every message line, taken NOW, before the commit and before `release`: `release` (releaseInboundLines) deletes the line from the page's pending map, and `hashesOf` reads that map, so a lookup made
	// after `release` answers nothing. Nothing below calls `hashesOf` again.
	const hashesOfLine = new Map<string, string[]>()
	for (const line of [...rowLines, ...duplicateLines]) hashesOfLine.set(line, free(unique(deps.hashesOf([line]))))
	const dropHashesAll = free(unique(deps.hashesOf(dropLines)))
	const dropHashes = browser ? dropHashesAll.filter((h) => !rowOrDup.has(h)) : dropHashesAll
	// The dedupe marker of a message line is the proof that its append was confirmed (written by the wait, after the confirmation, right before the ACK); this step marks DROPPED lines only, and never a hash whose wait
	// is already running.
	const markNow = dropHashes.filter((h) => !(browser && isDurablePending(h)))
	let added: string[] = []
	if (browser && markNow.length) added = deps.markHashes(markNow)
	const stored = await deps.commit()
	if (!stored) {
		if (added.length) deps.unmarkHashes(added)
		return false
	}
	deps.release([...rowLines, ...duplicateLines, ...dropLines])
	if (browser) {
		// The rows and the duplicate copies that have an append to wait for: their ACK is the wait's, sent after the confirmed append (a background wait, not blocking this step: the write lock ends with the commit).
		// A hash whose wait is already running is not started twice and is not ACKed by anyone else.
		const durableItems: Array<{ hash: string; mirror: DurableMirror }> = []
		let noWait = 0
		for (const line of [...rowLines, ...duplicateLines]) {
			const mirror = input.durable?.get(line)
			if (!mirror) {
				noWait += 1
				continue
			}
			for (const hash of hashesOfLine.get(line) ?? []) durableItems.push({ hash, mirror })
		}
		// diagnostics only (counts and short ids; nothing else): which branch each message line took
		if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') {
			for (const line of rowLines) qaEvent(input.durable?.get(line) ? 'row_wait' : 'row_nowait', input.durable?.get(line)?.sendId, shortHash(hashesOfLine.get(line)?.[0]))
			for (const line of duplicateLines) qaEvent(input.durable?.get(line) ? 'dup_wait' : 'dup_nowait', input.durable?.get(line)?.sendId, shortHash(hashesOfLine.get(line)?.[0]))
		}
		if (noWait) {
			try { deps.durableOptions?.log?.(`${noWait} message line(s) have no history append to wait for: no ACK is sent, the mailbox sends them again`) } catch { /* a log line never decides anything */ }
		}
		const ackNow = dropHashes.filter((h) => !isDurablePending(h))
		// diagnostics only (counts): after this change the number of waits equals the number of message lines that have an append, and ackNow holds dropped lines only
		if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') qaEvent('settle_counts', undefined, `d${durableItems.length}a${ackNow.length}r${rowLines.length}u${duplicateLines.length}`)
		if (durableItems.length) {
			void startDurableAck(
				durableItems,
				{ ackMailbox: deps.target.ackMailbox, markHashes: deps.markHashes, unmarkHashes: deps.unmarkHashes },
				deps.durableOptions,
			).catch(() => undefined)
		}
		if (ackNow.length) {
			if (process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') for (const h of ackNow) qaEvent('ack_drop', undefined, shortHash(h))
			deps.target.ackMailbox(ackNow)
		}
		return true
	}
	if (deps.target.nativeAckAfterAppend) {
		// native, ack after append. The same wait as the browser; its ACK is `ackInbound`. A duplicate copy whose hash was already ACKed needs nothing; a row or duplicate with no append to wait for is NOT ACKed (the
		// shell keeps the armor and replays it); there are no page dedupe markers on this path (the shell owns the replay), so the wait marks nothing.
		const nativeItems: Array<{ hash: string; mirror: DurableMirror }> = []
		let nativeNoWait = 0
		for (const line of [...rowLines, ...duplicateLines]) {
			const mirror = input.durable?.get(line)
			if (!mirror) { nativeNoWait += 1; continue }
			for (const hash of hashesOfLine.get(line) ?? []) if (!deps.target.alreadyAcked(hash)) nativeItems.push({ hash, mirror })
		}
		if (nativeNoWait) {
			try { deps.durableOptions?.log?.(`${nativeNoWait} message line(s) have no history append to wait for: no ackInbound is sent, the shell keeps the armor`) } catch { /* a log line never decides anything */ }
		}
		if (nativeItems.length) {
			void startDurableAck(
				nativeItems,
				{ ackMailbox: deps.target.ackDisplayed, markHashes: () => undefined, unmarkHashes: () => undefined },
				deps.durableOptions,
			).catch(() => undefined)
		}
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

