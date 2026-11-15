/**
 * Recording one inbound line after its chat row has been written.
 *
 * A line joins the ACK lists only when its row is in the page state: the write is the last step that can fail. The optional mirror
 * (encrypted history) runs before the write, so if it throws the row is not written and the line is not recorded either. A duplicate
 * copy (the row was already there) is recorded apart from new rows, so the native ACK can be held back for it.
 */

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
}

export const newInboundLists = (): InboundLists => ({ stored: [], duplicates: [], dropped: [], rejected: [] })

export type InboundRowSteps = {
	/** Runs before the write, for new rows only (for example the encrypted history mirror). A throw leaves the line unrecorded. */
	mirror?: () => void
	/** Writes the row into the page state. A throw leaves the line unrecorded. */
	write: () => void
}

/** Records one line once its write has succeeded. Throws what the steps throw, after recording nothing. */
export function recordInboundLine(lists: InboundLists, line: string, isNew: boolean, steps: InboundRowSteps): void {
	if (isNew && steps.mirror) steps.mirror()
	steps.write()
	if (isNew) lists.stored.push(line)
	else lists.duplicates.push(line)
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
export function settleInputOf(lists: InboundLists): { rowLines: string[]; duplicateLines: string[]; dropLines: string[] } {
	return { rowLines: lists.stored, duplicateLines: lists.duplicates, dropLines: lists.dropped }
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
 * - `unparseable`: the text is not JSON (or is JSON null). A dropped frame: marker, then ACK.
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
