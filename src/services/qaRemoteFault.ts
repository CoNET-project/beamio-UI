/**
 * "模拟远端提交失败" (simulated remote-commit failure), hook variant only.
 *
 * A switch on the TESTED page that makes the REMOTE part of ITS OWN inbound history append fail in a controlled way and then work again: the local copy (index record, fragment cache, library row) is made as usual, the
 * remote commit (fragment upload, index upload, on-chain pointer) fails at the chosen step, so the append rejects `remote_commit_failed:<step>` and the mailbox ACK must NOT follow. Switch it off and the mailbox
 * redelivery (or the page's own retry) resumes the commit through the real remote, and only then is the line ACKed.
 *   upload the fragment upload fails pointer the pointer move fails timeout the remote step hangs for its whole step budget, then fails
 * The fault travels with the `historyAppend` worker command (`qaRemoteFault`), so no global in the worker, no storage, no URL parameter. The mode lives in memory only: a kill and a restart start with it off.
 * COMPILE-TIME SWITCH: every reader is behind the inline `process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true'` test (DefinePlugin folds it, the minifier removes the branch); the switch component is mounted only under it
 * (index.tsx). A production bundle contains none of this: the freeze grep for `qaRemoteFault` and the label must be 0 in the production main JS, the worker and the shell ZIP.
 */
export type QaRemoteFaultMode = 'off' | 'upload' | 'pointer' | 'timeout'

let mode: QaRemoteFaultMode = 'off'
let hits = 0
const listeners = new Set<() => void>()

export const qaRemoteFaultMode = (): QaRemoteFaultMode => mode
export const qaRemoteFaultHits = (): number => hits
export function setQaRemoteFaultMode(next: QaRemoteFaultMode): void {
	if (next !== 'off' && next !== 'upload' && next !== 'pointer' && next !== 'timeout') return
	mode = next
	for (const l of [...listeners]) {
		try { l() } catch { /* a listener that throws does not stop the others */ }
	}
}
export function onQaRemoteFaultChange(listener: () => void): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/** the fault to hand to this append, or undefined (off, or not a hook build). Counts a hit when a fault is handed out. */
export function qaRemoteFaultForAppend(): 'upload' | 'pointer' | 'timeout' | undefined {
	if (process.env.REACT_APP_QA_ACK_ORDER_HOOK !== 'true') return undefined
	if (mode === 'off') return undefined
	hits += 1
	return mode
}

export function resetQaRemoteFaultForTest(): void {
	mode = 'off'
	hits = 0
	listeners.clear()
}
