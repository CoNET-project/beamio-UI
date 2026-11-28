/**
 * WHERE the copy of a message that shows right after a mount comes from. Hook variant only: every call site is `if (QA_ACK_ORDER_HOOK)`, so a production bundle has none of it.
 * Four sources, named by where the copy entered the page:
 *   record the stored account record (the message was in it with a body)
 *   queue put back from the send queue (queue document restore: messagesForUnlisted / restoreOnMount)
 *   library merged in from the local library read (the conversation's own read, mergeHistoryEntriesIntoMessages)
 *   app_history the App-level history restore that merges decrypted worker history into the page's chats (commitRestorePlan)
 * The registry holds sendIds in memory only; the output is the NAME of the source (plain words, joined for a mix), never an id and never a body.
 */
export type QaCopySource = 'record' | 'queue' | 'library' | 'app_history'
const ORDER: readonly QaCopySource[] = ['queue', 'library', 'app_history', 'record']
const marks = new Map<string, Set<QaCopySource>>()
const MAX = 5000

/** the sendId of a history entry: its own field, else the one inside its JSON body (the body is parsed, never kept or printed) */
export function qaSendIdOfEntry(entry: { sendId?: unknown; body?: unknown }): string | null {
	if (typeof entry.sendId === 'string' && entry.sendId) return entry.sendId
	if (typeof entry.body === 'string') {
		try {
			const o = JSON.parse(entry.body) as { sendId?: unknown }
			if (o && typeof o.sendId === 'string' && o.sendId) return o.sendId
		} catch { /* not JSON */ }
	}
	return null
}

export function qaNoteCopy(source: QaCopySource, sendIds: Iterable<string | null | undefined>): void {
	for (const id of sendIds) {
		if (!id) continue
		const set = marks.get(id) ?? new Set<QaCopySource>()
		set.add(source)
		marks.set(id, set)
		if (marks.size > MAX) marks.delete(marks.keys().next().value as string)
	}
}

/**
 * The source name of the copies shown: for every shown sendId the strongest mark (queue, library, app_history, then the stored record when the id was in it with a body), the distinct names joined in a fixed order
 * with `_`; `unknown` when nothing is known. Plain words only.
 */
export function qaClassifyCopyNames(shownIds: Iterable<string>, recordIdsWithBody: ReadonlySet<string>): string[] {
	const names = new Set<QaCopySource | 'unknown'>()
	for (const id of shownIds) {
		const m = marks.get(id)
		const hit = m ? ORDER.find((s) => s !== 'record' && m.has(s)) : undefined
		if (hit) names.add(hit)
		else if (recordIdsWithBody.has(id)) names.add('record')
		else names.add('unknown')
	}
	if (names.size === 0) return ['unknown']
	return [...ORDER, 'unknown' as const].filter((n) => names.has(n))
}
export const qaClassifyCopies = (shownIds: Iterable<string>, recordIdsWithBody: ReadonlySet<string>): string => qaClassifyCopyNames(shownIds, recordIdsWithBody).join('_')

/** the classified source of the FIRST copy shown after a mount, per conversation (peer cut to its last 6 characters); read by the state export. Plain words only. */
let firstCopy: { peer: string; source: string } | null = null
export function qaSetFirstCopySource(peer: string, source: string): void {
	firstCopy = { peer: String(peer).toLowerCase().slice(-6), source: String(source).replace(/[^a-z_]/g, '').slice(0, 48) }
}
export function qaFirstCopySourceOf(peer: string): string | null {
	return firstCopy && firstCopy.peer === String(peer).toLowerCase().slice(-6) ? firstCopy.source : null
}

export function resetQaCopySourceForTest(): void { marks.clear(); firstCopy = null }
