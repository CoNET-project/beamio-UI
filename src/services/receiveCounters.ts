/**
 * the RECEIVING side's counters, for the hook variant only. They answer "does the same ciphertext (the same sendId) reach the recipient's page a second time" (the choice between design 2
 * A and B), and they count what the page ACTUALLY did with a receipt, never what it received.
 *
 * Per id (the last 8 characters of the page's message key, which is the sendId for a chat line) and in total:
 *   arr inbound lines that reached the batch (every line, new or not)
 *   dd dedupe hits: the line was already handled (page set, marker) or its row already existed
 *   ra delivery-receipt lines that ARRIVED (this page is the sender of that message): a count of received receipts, NOT of sent ones
 *   re sender receipts this page ATTEMPTED to send for a new row (browser path)
 *   ro of those, sent (the receipt POST was answered ok)
 *   rf of those, failed
 *   rk skipped because the sender's key / route was not verified (no receipt was sent)
 *   rn receipts left to the native module (shell: the page does not send them and cannot count the send)
 * Memory only, no text, no address, no tag. COMPILE-TIME SWITCH: every call site is `if (QA_ACK_ORDER_HOOK) rxNote(...)` (utils/qaAckOrder.ts), so a production bundle contains neither the calls nor this module's
 * strings; the freeze grep for the identifier `receiveCounters` must be 0 in the production main JS and in the shell ZIP.
 */
export type RxKind = 'arr' | 'dd' | 'ra' | 're' | 'ro' | 'rf' | 'rk' | 'rn'
export interface RxIdRow { id: string; arr: number; dd: number; ra: number; re: number; ro: number; rf: number; rk: number; rn: number }
export interface RxSnapshot { totals: Record<RxKind, number>; ids: RxIdRow[] }

const KINDS: readonly RxKind[] = ['arr', 'dd', 'ra', 're', 'ro', 'rf', 'rk', 'rn']
const MAX_IDS = 24
const totals: Record<RxKind, number> = { arr: 0, dd: 0, ra: 0, re: 0, ro: 0, rf: 0, rk: 0, rn: 0 }
const rows = new Map<string, RxIdRow>()

export function rxNote(kind: RxKind, rawId: string): void {
	totals[kind] += 1
	const id = String(rawId || '').slice(-8)
	if (!id) return
	let row = rows.get(id)
	if (!row) {
		row = { id, arr: 0, dd: 0, ra: 0, re: 0, ro: 0, rf: 0, rk: 0, rn: 0 }
		rows.set(id, row)
		if (rows.size > MAX_IDS) rows.delete(rows.keys().next().value as string)
	} else {
		rows.delete(id) // most recent last
		rows.set(id, row)
	}
	row[kind] += 1
}

export function rxSnapshot(): RxSnapshot {
	return { totals: { ...totals }, ids: [...rows.values()].map((r) => ({ ...r })) }
}

export function resetReceiveCountersForTest(): void {
	for (const k of KINDS) totals[k] = 0
	rows.clear()
}
