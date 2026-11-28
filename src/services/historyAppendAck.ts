/**
 * the library ACK primitive. In library mode (senderCopy.ts) the sender's copy of a message is durable only when the worker ACKed `history.append`; this is the one function that says so.
 * A missing client, a refusal and a timeout all mean NO ACK (the queue item stays); only a resolved append is an ACK. Kept apart from chatWorkerBridge.ts so that it can be tested without a worker.
 *
 * an INBOUND append resolves only after the remote commit too (fragment upload, index upload, pointer move: worker/history.ts), so a failed append has two different meanings the page tells apart:
 * `local` (the local copy itself is not confirmed: "not saved") and a remote step code (the local copy is saved, the remote commit is pending: "remote not committed"). `appendFailureCodeOf` reads the worker's
 * error text (`remote_commit_failed:<step>`, carried over the worker boundary) into a code; the code of the last failed append of a sendId is kept in memory for the wait loop (inboundAppendFailure below).
 */

export type AppendFailureCode = 'local' | 'upload' | 'pointer' | 'index' | 'nofrag'

/** the worker's error text -> a code. Anything that is not a remote-commit failure (the library row, a locked library, a timeout of the worker request, a missing client) is `local`: not confirmed as saved. */
export function appendFailureCodeOf(message: string): AppendFailureCode {
	const m = /remote_commit_failed:([a-z_]+)/.exec(String(message ?? ''))
	if (!m) return 'local'
	switch (m[1]) {
		case 'record_missing': return 'local' // the index being committed did not hold the record: it is not confirmed as saved
		case 'upload': return 'upload'
		case 'index_upload': return 'index'
		case 'no_fragment': return 'nofrag'
		default: return 'pointer'
	}
}
/** true: the local copy is saved and only the remote commit is missing */
export const isRemoteFailure = (code: AppendFailureCode | undefined): boolean => code !== undefined && code !== 'local'

const lastFailure = new Map<string, AppendFailureCode>()
export const noteAppendFailure = (sendId: string | undefined, code: AppendFailureCode): void => {
	if (!sendId) return
	lastFailure.delete(sendId)
	lastFailure.set(sendId, code)
	if (lastFailure.size > 500) {
		const oldest = lastFailure.keys().next().value
		if (oldest !== undefined) lastFailure.delete(oldest)
	}
}
export const clearAppendFailure = (sendId: string | undefined): void => { if (sendId) lastFailure.delete(sendId) }
export const appendFailureOf = (sendId: string | undefined): AppendFailureCode | undefined => (sendId ? lastFailure.get(sendId) : undefined)
export const resetAppendFailuresForTest = (): void => lastFailure.clear()

export interface AppendAckHooks<O> {
	/** the failure text of the append (never thrown out of here) */
	onFail?: (message: string) => void
	/** the second argument of the client's append (hook builds: the remote fault) */
	opts?: O
}

export async function appendHistoryAck<E, O = undefined>(client: { history: { append(entry: E, opts?: O): Promise<unknown> } } | null | undefined, entry: E, hooks?: AppendAckHooks<O>): Promise<boolean> {
	if (!client) return false
	try {
		await (hooks?.opts !== undefined ? client.history.append(entry, hooks.opts) : client.history.append(entry))
		return true
	} catch (ex) {
		try { hooks?.onFail?.(ex instanceof Error ? ex.message : String(ex)) } catch { /* a diagnostic never decides anything */ }
		return false
	}
}
