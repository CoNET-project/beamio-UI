/**
 * "模拟传输故障" (simulated transport fault), hook variant only.
 *
 * A switch on the TESTED page that makes ITS OWN outgoing requests fail in a controlled way and then work again: the other end (another device or page) is not touched and stays online. Two modes:
 *   network_error the request does not go out and the send answers a clear failure at once (like a network error);
 *   timeout the send waits for its whole attempt budget and then answers a failure (like a request that never gets an answer).
 * The gate sits at the two places where a page's send leaves it: chat.ts sendMessage (browser; before the entry POST, after the armor is stored) and chatWorkerBridge.ts sendChatViaNativeDaemon (shell; before the native
 * command). Everything above them (the queue document, the stored armor, the same sendId, the awaiting / failed states, the resume) is the normal path and runs unchanged: only the transport result is forced.
 * It does NOT mark any real entry node as bad (it fails before a node is picked), so a test does not leave the node pool worse than it found it.
 *
 * Control: the on-screen switch (components/QaTransportFaultSwitch.tsx), tapped in the simulator: no debugger, no script, no URL parameter, no storage. The mode lives in memory only, so a kill and a restart start with the
 * service restored (mode off). COMPILE-TIME SWITCH: every call site is `if (QA_ACK_ORDER_HOOK) ...` (utils/qaAckOrder.ts) and the switch is mounted only under it, so a production bundle contains none of this; the freeze
 * grep for `qaTransportFault` and the label must be 0 in the production main JS and the shell ZIP.
 * The overlay says "模拟传输故障"; in the coverage notes this is the only name for it. It is NOT a real disconnection: the "传输实测" (a real disconnect and restore against an independent endpoint) is a separate item and has no plan yet.
 */
export type QaFaultMode = 'off' | 'network_error' | 'timeout'

let mode: QaFaultMode = 'off'
let hits = 0
const listeners = new Set<() => void>()

export const qaFaultMode = (): QaFaultMode => mode
export const qaFaultHits = (): number => hits
export function setQaFaultMode(next: QaFaultMode): void {
	if (next !== 'off' && next !== 'network_error' && next !== 'timeout') return
	mode = next
	for (const l of [...listeners]) {
		try { l() } catch { /* a listener that throws does not stop the others */ }
	}
}
export function onQaFaultChange(listener: () => void): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/**
 * Called by a send just before its request would leave. Resolves false when there is no fault (the send goes on); true when this attempt must FAIL (the caller then returns its ordinary failure).
 * `budgetMs` is how long a `timeout` fault holds the attempt: the send's own attempt budget.
 */
export async function qaTransportFaultGate(budgetMs: number, timer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)): Promise<boolean> {
	if (mode === 'off') return false
	hits += 1
	if (mode === 'timeout') await new Promise<void>((resolve) => { timer(resolve, Math.max(0, budgetMs)) })
	return true
}

export function resetQaTransportFaultForTest(): void {
	mode = 'off'
	hits = 0
	listeners.clear()
}
