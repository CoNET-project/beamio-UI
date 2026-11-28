/**
 * What the chat list shows while the full history read of a shell settles. 'loading' until the read has settled (entries merged, a
 * confirmed empty result, or the cold-start window used up); 'settled' after. A browser is always 'settled' (its rules are unchanged).
 */
import type { CorpusReadStatus } from './historyCorpusRead'
import { isShellContext } from './shellContext'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

let status: CorpusReadStatus = 'loading'
const listeners = new Set<(s: CorpusReadStatus) => void>()

export function getHistoryListStatus(): CorpusReadStatus {
	return isShellContext() ? status : 'settled'
}
export function setHistoryListStatus(next: CorpusReadStatus): void {
	if (next === status) return
	status = next
	// a change of what the list shows reaches the native log (a device capture shows when "Loading conversations…" ended)
	publishNativePwaLog('info', `[history] list status ${next}`)
	for (const l of [...listeners]) l(next)
}
export function subscribeHistoryListStatus(l: (s: CorpusReadStatus) => void): () => void {
	listeners.add(l)
	return () => {
		listeners.delete(l)
	}
}
export function resetHistoryListStatusForTest(): void {
	status = 'loading'
	listeners.clear()
}
