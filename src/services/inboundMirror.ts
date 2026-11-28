/**
 * the history mirror of ONE inbound message line (a new row, or a duplicate copy of a row), as a pure function so the decision is tested and App.tsx cannot drift from it.
 *
 * In the browser (the TS worker that owns the library) EVERY message line's append is started and handed to the settle step as a `DurableMirror`, whatever the persistence mode reads, and the line's mailbox ACK
 * waits for the append (no mode may release the ACK early: the mode read when the row is recorded and the mode that later decides whether a committed record keeps bodies can differ, and the
 * evidence can move both ways, so a body that is in the record at the commit can be stripped by the next ordinary commit while its append is still in the worker queue). The append is idempotent by sendId, so a
 * duplicate copy simply confirms that the library holds the row. The price: a record-mode account's ACK waits for the append too (about 8 to 12 s), and the "not saved" mark can light for a row whose body is in the record.
 * a browser line whose row cannot be found (`added` is null) returns NOTHING and is counted: it is not mirrored and the settle step never ACKs it (the mailbox sends it again). It must NOT fall back to the old
 * fire-and-forget call, which let the settle step ACK it with no copy anywhere.
 * A native shell that declares `inbound.deferAck` (nativeAckAfterAppend) is treated exactly like the browser: every message line, new or duplicate, with or without a sendId, returns a DurableMirror and its `ackInbound`
 * waits for the append result. A native shell without it keeps the old fire-and-forget mirror for a NEW row (a duplicate is not mirrored again) and returns nothing.
 */
import type { DurableMirror } from './inboundDurable'
import type { AppendFailureCode } from './historyAppendAck'
import { qaEvent } from '../utils/qaAckOrder'

export interface InboundMirrorInput<M extends { sendId?: unknown }> {
	/** the browser TS worker is the active client (inboundAckIsBrowser) */
	browser: boolean
	/**
	 * a native shell that declares `inbound.deferAck` AND whose page declares `ackAfterAppend.v1` (nativeAckAfterAppendActive): its `ackInbound` waits for the append result exactly like the
	 * browser's mailbox ACK. false / absent: the old native fire-and-forget mirror (a shell without deferAck sends no `ackInbound` at all, so nothing waits).
	 */
	nativeAckAfterAppend?: boolean
	/** false: the row was already in the page state (a duplicate copy) */
	isNew: boolean
	/** the page's own key of this message (processedIds / storedRowKeys): handed to the wait so an abandoned wait can forget the line */
	msgKey?: string
	peer: string
	/** the row as it is in the page state; null when it cannot be found */
	added: M | null
	/** the awaited append: true only when the worker confirmed it */
	ack: (peer: string, msg: M, dir: 'in') => Promise<boolean>
	/** the old fire-and-forget mirror */
	fireAndForget: (peer: string, msg: M | undefined, dir: 'in') => void
	/** why the last append of this sendId failed (historyAppendAck.appendFailureOf); lets the wait tell "not saved" from "saved here, remote not committed" */
	failureOf?: (sendId: string | undefined) => AppendFailureCode | undefined
	/** something else that must be on disk before this line may be acknowledged (the pending delivery receipt): false, or a throw, holds the ACK like a failed append; asked again with every retry */
	alsoRequire?: () => Promise<boolean>
	/** a browser line with no row to mirror (counted by the caller) */
	onUnmirrored?: () => void
}

export function inboundMirrorFor<M extends { sendId?: unknown }>(input: InboundMirrorInput<M>): DurableMirror | undefined {
	const { added } = input
	if (input.browser || input.nativeAckAfterAppend === true) {
		if (!added) {
			try { input.onUnmirrored?.() } catch { /* a counter never decides anything */ }
			return undefined
		}
		const sendId = typeof added.sendId === 'string' ? added.sendId : undefined
		const required = async (): Promise<boolean> => {
			if (!input.alsoRequire) return true
			try { return (await input.alsoRequire()) === true } catch { return false }
		}
		const appended = (): Promise<boolean> =>
			input.ack(input.peer, added, 'in').then(
				(ok) => {
					// diagnostics only: the append was confirmed (sendId tail; the time is the event's own)
					if (ok && process.env.REACT_APP_QA_ACK_ORDER_HOOK === 'true') qaEvent('append_ok', sendId)
					return ok
				},
				() => false,
			)
		// both are started at once; the line counts as stored only when both are
		const attempt = (): Promise<boolean> => Promise.all([required(), appended()]).then(([a, b]) => a && b)
		return { done: attempt(), retry: attempt, sendId, msgKey: input.msgKey, failure: input.failureOf ? () => input.failureOf?.(sendId) : undefined }
	}
	if (input.isNew) input.fireAndForget(input.peer, added || undefined, 'in')
	return undefined
}
