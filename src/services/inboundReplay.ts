/**
 * which REPLAYED inbound lines may be ACKed (a line that comes again in the same session: a reconnect, a foreground resume, a redelivery while the first copy is still being processed).
 *
 * In the browser a replayed line is ACKed ONLY when its armor hash already carries a dedupe marker. That marker is written by exactly one thing: the wait for the history append, after the append was confirmed
 * and right before its ACK (inboundDurable.ts), or by the settle step for a DROPPED line. So a marker means "the append of this line is confirmed" (or the line was dropped on purpose), and confirming the ACK
 * again is safe. A replayed line WITHOUT a marker (its first copy is still in flight, or its wait was abandoned, or it never got one) is held: no ACK, the mailbox sends it again, the page de-duplicates by sendId.
 * (Before a replay was ACKed after the commit when the page "already had" the row, or as a dropped line when the row was not stored yet: a chat line replayed while its first copy was still being processed was
 * ACKed within about a second, before its append, which takes 8 to 12 s.)
 * The lines that may be ACKed go to the settle step as DROPPED lines (nothing to keep: the ACK is confirmed again); nothing is passed as a row. A native shell keeps the old split.
 */
export interface ReplayPlan {
	rowLines: string[]
	dropLines: string[]
	/** browser lines held back (no marker): not ACKed, counted */
	held: string[]
	/** browser lines whose ACK is confirmed again (marker present) */
	confirmed: string[]
}

export function planReplayAcks(input: { browser: boolean; rows: readonly string[]; drops: readonly string[]; hasMarker: (line: string) => boolean }): ReplayPlan {
	if (!input.browser) return { rowLines: [...input.rows], dropLines: [...input.drops], held: [], confirmed: [] }
	const confirmed: string[] = []
	const held: string[] = []
	for (const line of [...input.rows, ...input.drops]) {
		let marked = false
		try {
			marked = input.hasMarker(line) === true
		} catch {
			marked = false
		}
		;(marked ? confirmed : held).push(line)
	}
	return { rowLines: [], dropLines: confirmed, held, confirmed }
}
