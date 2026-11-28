/**
 * the small documents of the chat page in the account database, other than the account record `init`:
 *
 *   chat-draft-v1:<eoa> the text being typed (chatDraftStore.ts)
 *   chat-queue-v1:<eoa>:<sendId> a message the user clicked send on (sendQueue.ts)
 *   chat-receipt-v1:<eoa>:<peerTag>:<sendTag> the recipient's delivery receipt as evidence (receiptEvidence.ts)
 *   chat-delivered-v1:<eoa>:<peerTag>:<sendTag> the sender's own message was delivered (deliveredMarks.ts)
 *
 * One place for the three rules that must agree: which ids the page adapter may remove (a removal of anything else, `init` above all, is refused), which documents the explicit local wallet reset wipes,
 * and the wipe itself. Pure over an adapter, so it is tested without the database.
 *
 * the adapter accepts the removal of all four classes of chat documents (draft, queue, receipt, delivered) and of nothing else.
 *
 * What the reset wipes: the receipt and delivered documents. The draft and queue documents are NOT wiped here: they hold message text
 * (in a shell as base64 JSON), the queue also holds messages that were never sent and an older release's queue documents carry plaintext contacts and sendIds in their ids; changing that is a separate data decision, not something to do by a side effect of this change.
 */
export const CHAT_AUX_DOC_ID = /^chat-(draft|queue|receipt|delivered)-v1:/
export const CHAT_RECEIPT_DOC_PREFIX = 'chat-receipt-v1:'
export const CHAT_DELIVERED_DOC_PREFIX = 'chat-delivered-v1:'
/** the document classes the explicit local wallet reset removes (all accounts: the reset deletes the device's wallet record) */
export const WIPED_ON_RESET_PREFIXES: readonly string[] = [CHAT_RECEIPT_DOC_PREFIX, CHAT_DELIVERED_DOC_PREFIX]

/** True for an id the chat page adapter may remove. `init` and every other id are refused. */
export const isChatAuxDocId = (docId: string): boolean => docId !== 'init' && CHAT_AUX_DOC_ID.test(docId)

export interface ChatAuxWipeAdapter {
	list(prefix: string): Promise<string[]>
	remove(docId: string): Promise<void>
}

/**
 * Removes every document of the given classes. Every document is tried; resolves with how many were removed and rejects (after trying all) when any removal or the listing failed, so the caller can tell the user
 * that data may remain.
 */
export async function wipeChatAuxDocs(adapter: ChatAuxWipeAdapter, prefixes: readonly string[] = WIPED_ON_RESET_PREFIXES): Promise<number> {
	let removed = 0
	let failure: unknown = null
	for (const prefix of prefixes) {
		let ids: string[]
		try {
			ids = (await adapter.list(prefix)).filter((id) => id.startsWith(prefix))
		} catch (error) {
			failure = failure ?? error
			continue
		}
		for (const id of ids) {
			try {
				await adapter.remove(id)
				removed += 1
			} catch (error) {
				failure = failure ?? error
			}
		}
	}
	if (failure !== null) throw failure instanceof Error ? failure : new Error('chat_aux_wipe_failed')
	return removed
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The explicit local reset and the messages that were never sent: the reset shows how many unsent items it would delete, says what deleting does, lets the user cancel, and
// deletes the queue and draft documents ONLY after the user confirmed that; cancelling deletes nothing; nothing is cleaned automatically; with nothing unsent the flow is as before.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
export const CHAT_QUEUE_DOC_PREFIX = 'chat-queue-v1:'
export const CHAT_DRAFT_DOC_PREFIX = 'chat-draft-v1:'
/** the classes that hold text the user wrote and the app has not delivered: removed by the reset only after the user confirmed it */
export const UNSENT_PREFIXES: readonly string[] = [CHAT_QUEUE_DOC_PREFIX, CHAT_DRAFT_DOC_PREFIX]

/** `queued`: the unsent messages (one queue document each); `hasDraft`: text that was typed and not sent; `unknown`: the listing failed, so it cannot be said that nothing is unsent */
export interface UnsentSummary {
	queued: number
	hasDraft: boolean
	unknown: boolean
	/** messages (sent AND received) not yet saved to the encrypted cloud history; 'unknown' when that cannot be read, which counts as "there may be some" */
	unarchived: number | 'unknown'
}

/** how long the reset waits for one of its reads before it counts as unreadable */
export const SUMMARY_READ_TIMEOUT_MS = 5_000
const within = <T,>(work: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('summary_read_timeout')), ms)
	work.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
})

/**
 * Counts from the document ids alone (nothing is decoded: a queue document that cannot be read still counts). Never throws, and never stays unanswered: a read that fails OR does not answer in time is
 * `unknown`, which asks for the second confirmation. A read that hangs must not leave the reset button disabled for good.
 */
export async function readUnsentSummary(adapter: Pick<ChatAuxWipeAdapter, 'list'> | undefined, readUnarchived?: () => Promise<number>, timeoutMs: number = SUMMARY_READ_TIMEOUT_MS): Promise<UnsentSummary> {
	const readArchiveSide = async (): Promise<number | 'unknown'> => {
		if (!readUnarchived) return 'unknown'
		try { const n = await within(readUnarchived(), timeoutMs); return Number.isInteger(n) && n >= 0 ? n : 'unknown' } catch { return 'unknown' }
	}
	const readLocalSide = async (): Promise<Pick<UnsentSummary, 'queued' | 'hasDraft' | 'unknown'>> => {
		const source = adapter as Pick<ChatAuxWipeAdapter, 'list'>
		try {
			const queued = (await within(source.list(CHAT_QUEUE_DOC_PREFIX), timeoutMs)).filter((id) => id.startsWith(CHAT_QUEUE_DOC_PREFIX)).length
			const hasDraft = (await within(source.list(CHAT_DRAFT_DOC_PREFIX), timeoutMs)).some((id) => id.startsWith(CHAT_DRAFT_DOC_PREFIX))
			return { queued, hasDraft, unknown: false }
		} catch {
			return { queued: 0, hasDraft: false, unknown: true }
		}
	}
	const [unarchived, local] = await Promise.all([readArchiveSide(), readLocalSide()])
	return { ...local, unarchived }
}

/** True when the reset must show the warning and ask for the extra confirmation */
export const hasUnsent = (s: UnsentSummary): boolean => s.unknown || s.queued > 0 || s.hasDraft
/** something may be lost by deleting: unsent text or messages, or messages not (provably) saved to the cloud history. Asks for a second confirmation; it never blocks the reset for good. */
export const hasUnsaved = (s: UnsentSummary): boolean => hasUnsent(s) || s.unarchived !== 0

/** What the reset may delete: the unsent classes only when the user has confirmed them; otherwise they are untouched */
export const resetPrefixes = (includeUnsent: boolean): readonly string[] => (includeUnsent ? [...WIPED_ON_RESET_PREFIXES, ...UNSENT_PREFIXES] : WIPED_ON_RESET_PREFIXES)

/** The reset button is enabled when the generic confirmation is checked and, when something is unsent, the unsent confirmation too */
export const canConfirmReset = (input: { confirmGeneric: boolean; confirmUnsent: boolean; summary: UnsentSummary | null; busy: boolean }): boolean =>
	!input.busy && input.confirmGeneric && input.summary !== null && (!hasUnsaved(input.summary) || input.confirmUnsent)

/** The English lines of the warning (the lock screen is English-only today; draft wording) */
export function unsentWarningLines(s: UnsentSummary): { headline: string; effect: string; checkbox: string } {
	const unsent = !hasUnsent(s)
		? ''
		: s.unknown
			? 'This device could not check whether messages are still waiting to be sent.'
			: s.queued > 0
				? `This device still holds ${s.queued} message${s.queued === 1 ? '' : 's'} that ${s.queued === 1 ? 'has' : 'have'} not been sent${s.hasDraft ? ', and text you typed but did not send' : ''}.`
				: 'This device still holds text you typed but did not send.'
	const unsaved = s.unarchived === 0
		? ''
		: s.unarchived === 'unknown'
			? 'This device cannot tell whether all sent and received messages have been saved to your encrypted cloud history.'
			: `${s.unarchived} sent or received message${s.unarchived === 1 ? ' has' : 's have'} not been saved to your encrypted cloud history yet.`
	return {
		headline: [unsent, unsaved].filter(Boolean).join(' '),
		effect: `${hasUnsent(s) ? 'If you delete the local data now, unsent messages are deleted from this device and will never be sent; the people you wrote to will not receive them. ' : ''}${s.unarchived === 0 ? '' : 'Deleting removes the copy on this device; messages that were not saved may not be recoverable from the cloud history. '}Tap Back to cancel: nothing is deleted.`,
		checkbox: hasUnsent(s) ? 'I understand the unsent messages will be deleted and never sent, and unsaved messages may be lost.' : 'I understand messages that were not saved may be lost.',
	}
}
