/**
 * Recording one inbound line after its chat row has been written.
 *
 * A line joins the ACK lists only when its row is in the page state: the write is the last step that can fail. The optional mirror
 * (encrypted history) runs before the write, so if it throws the row is not written and the line is not recorded either. A duplicate
 * copy (the row was already there) is recorded apart from new rows, so the native ACK can be held back for it.
 */

import type { DurableMirror } from './inboundDurable'

/**
 * The lists of one inbound batch. Each line is in exactly one list.
 * - `stored`: its row was written by this batch.
 * - `duplicates`: its row was already in the page state (a copy that was not new).
 * - `dropped`: consumed without a row (voice control, delivery receipt, non-chat, parse failure). Browser: marker, then ACK after the
 * commit. Native: nothing.
 * - `rejected`: the signature is not valid. Not delivered, not stored, no marker, no ACK. Never passed to the settle step.
 */
export type InboundLists = {
	stored: string[]
	duplicates: string[]
	dropped: string[]
	rejected: string[]
	/**
	 * the new rows (a subset of `stored`) whose mailbox ACK must wait for the history append (library mode): line -> that row's append. Created on first use, so a batch without one has no field.
	 */
	durable?: Map<string, DurableMirror>
}

export const newInboundLists = (): InboundLists => ({ stored: [], duplicates: [], dropped: [], rejected: [] })

export type InboundRowSteps = {
	/**
	 * Runs before the write, for new rows only (for example the encrypted history mirror). A throw leaves the line unrecorded.
	 * it may return the row's append (`DurableMirror`); the line is then recorded as durable-pending and its mailbox ACK waits for the confirmed append (inboundDurable.ts). No return: nothing to wait for (record mode).
	 */
	mirror?: (isNew: boolean) => void | DurableMirror
	/** Writes the row into the page state. A throw leaves the line unrecorded. */
	write: () => void
}

/** Records one line once its write has succeeded. Throws what the steps throw, after recording nothing. */
export function recordInboundLine(lists: InboundLists, line: string, isNew: boolean, steps: InboundRowSteps): void {
	// the mirror is asked for a duplicate copy too (the caller decides what it does with `isNew`): a duplicate line in the browser is ACKed only after its append is confirmed (the append is idempotent by sendId),
	// never because "the page already has it"
	const durable = steps.mirror ? steps.mirror(isNew) : undefined
	steps.write()
	if (isNew) lists.stored.push(line)
	else lists.duplicates.push(line)
	if (durable) (lists.durable ??= new Map()).set(line, durable)
}

/** A line consumed without a row (see InboundLists.dropped). */
export function recordDroppedLine(lists: InboundLists, line: string): void {
	lists.dropped.push(line)
}

/** A line whose signature is not valid (see InboundLists.rejected). */
export function recordRejectedLine(lists: InboundLists, line: string): void {
	lists.rejected.push(line)
}

/**
 * The input of the settle step for a batch. `rejected` lines are left out on purpose: they get no marker and no ACK, on either path.
 */
export function settleInputOf(lists: InboundLists): { rowLines: string[]; duplicateLines: string[]; dropLines: string[]; durable?: ReadonlyMap<string, DurableMirror> } {
	return { rowLines: lists.stored, duplicateLines: lists.duplicates, dropLines: lists.dropped, ...(lists.durable && lists.durable.size ? { durable: lists.durable } : {}) }
}

/**
 * One inbound line as JSON. Null when the text is not JSON: a dropped frame, with no row and no native ACK. The check is
 * done before anything else reads the line, so an unparseable line never reaches the row steps.
 */
export function parseInboundLine<T = unknown>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T
	} catch {
		return null
	}
}

/**
 * The first decision on a raw inbound line, before any signature check:
 * - `unparseable`: the text is not JSON (or is JSON null). A dropped frame: marker, then ACK (drop and acknowledge; it covers ONLY frames that were decrypted and do
 *   not parse. A receipt line whose evidence cannot be kept stays held (no ACK); JSON without a timestamp keeps its previous behaviour; a frame that cannot be decrypted never reaches the page).
 * - `rejected`: JSON that cannot be a signed chat line: not an object, or without `text` or `signMessage`. Not delivered, no marker,
 * no ACK. The signature itself is checked by the caller, which owns the signer recovery.
 * - `signed`: a JSON object with `text` and `signMessage`; the caller checks the signature next.
 */
export type InboundLineClass =
	| { kind: 'unparseable' }
	| { kind: 'rejected' }
	| { kind: 'signed'; message: Record<string, unknown> & { text: unknown; signMessage: unknown } }

export function classifyInboundLine(raw: string): InboundLineClass {
	const parsed = parseInboundLine<unknown>(raw)
	if (parsed === null || parsed === undefined) return { kind: 'unparseable' }
	if (typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'rejected' }
	const obj = parsed as Record<string, unknown>
	if (!obj.text || !obj.signMessage) return { kind: 'rejected' }
	return { kind: 'signed', message: obj as Record<string, unknown> & { text: unknown; signMessage: unknown } }
}

/**
 * The page's first routing of a line that arrived in a batch (App.tsx processQueue), as a pure function so that the page's real path is tested:
 * - `drop_unparseable`: decided FIRST, before the dedupe marker and the message key are looked at (such a line has no key). It goes into the batch as a line to store, where it is recorded as a DROPPED line: the settle
 *   step marks it, commits and ACKs it. A redelivery takes the same route: ACKed again, nothing processed.
 * - `already_handled`: marked, or no message key (JSON without a timestamp), or seen by this page: the replay branch, unchanged.
 * - `fresh`: a new line to store.
 */
export type ArrivedLineRoute = 'drop_unparseable' | 'already_handled' | 'fresh'

export function routeArrivedLine(raw: string, state: { key: string | null | undefined; marked: boolean; seen: boolean }): ArrivedLineRoute {
	if (classifyInboundLine(raw).kind === 'unparseable') return 'drop_unparseable'
	if (state.marked || !state.key || state.seen) return 'already_handled'
	return 'fresh'
}

/** The log line of a batch's unparseable frames: a count and the last 8 hex digits of each armor hash, never the text */
export function unparseableDropLogLine(lineCount: number, armorHashes: readonly string[]): string {
	const tails = armorHashes.map((h) => String(h).toLowerCase().replace(/[^0-9a-f]/g, '').slice(-8)).join(',')
	return `${lineCount} frame(s) that do not parse are dropped (the browser ACKs them after the commit); hash tails: ${tails || 'none'}`
}
