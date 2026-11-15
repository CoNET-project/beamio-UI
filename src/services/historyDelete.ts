/**
 * the native history deletes. `historyDeleteMessage`deletes one message, by its conversation address
 * (convKey) and its message id (sendKey). `historyDeleteConversation` deletes one conversation, and only that one (its other conversations
 * and the messages those keep). Neither writes the page record. The page removes the conversation entry from its record
 * separately, from a freshly read record at its revision (the store's chat removal).
 *
 * Prepared, not wired into any screen: the commands go live when both SDKs implement them. The answer is one ack envelope
 * matched by reqId; the page sends through the one shell transport.
 */
import { nextReqId } from './nativeChatRouteRegister'
import { sendShellRecordCommand, type ShellRecordAnswer } from './shellRecordTransport'

export const HISTORY_DELETE_MESSAGE_COMMAND = 'historyDeleteMessage'
export const HISTORY_DELETE_CONVERSATION_COMMAND = 'historyDeleteConversation'
/**4: the reply timeout of one request. */
const TIMEOUT_MS = 10_000

export type HistoryDeleteResult = { ok: true; deleted: boolean } | { ok: false; code: string; names?: string[] }

/**2: `0x` followed by 40 lower-case hex digits. */
const CONV_KEY = /^0x[0-9a-f]{40}$/
/**2: 1 to 128 visible ASCII characters (0x21 to 0x7E). */
const MESSAGE_ID = /^[\x21-\x7e]{1,128}$/

export const isValidConvKey = (v: unknown): v is string => typeof v === 'string' && CONV_KEY.test(v)

/**
 * the page's addresses may be in checksum form; the command takes the lower-case form. The conversation key is
 * folded to lower case before it is checked and sent.
 */
export const toConvKey = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v)
export const isValidMessageId = (v: unknown): v is string => typeof v === 'string' && MESSAGE_ID.test(v)

export function buildHistoryDeleteMessageCommand(reqId: number, convKey: string, messageId: string): Record<string, unknown> {
	return { type: HISTORY_DELETE_MESSAGE_COMMAND, reqId, convKey, messageId }
}

export function buildHistoryDeleteConversationCommand(reqId: number, convKey: string): Record<string, unknown> {
	return { type: HISTORY_DELETE_CONVERSATION_COMMAND, reqId, convKey }
}

/** The answer as the page reads it: `result.code` ok with `deleted`, or a code (bad_request with the path names, busy), or an envelope error. */
export function parseHistoryDeleteAnswer(answer: ShellRecordAnswer): HistoryDeleteResult {
	if (answer.kind !== 'payload') return { ok: false, code: answer.kind }
	const p = answer.payload
	if (p.type !== 'ack') return { ok: false, code: 'bad_answer' }
	if (p.ok !== true) return { ok: false, code: typeof p.error === 'string' ? p.error : 'bad_answer' }
	const r = p.result
	if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, code: 'bad_answer' }
	const result = r as Record<string, unknown>
	if (result.code === 'ok' && typeof result.deleted === 'boolean') return { ok: true, deleted: result.deleted }
	const names = Array.isArray(result.names) ? result.names.filter((n): n is string => typeof n === 'string') : undefined
	return { ok: false, code: typeof result.code === 'string' ? result.code : 'bad_answer', ...(names ? { names } : {}) }
}

/** Deletes one message. Invalid input is refused on the page, before anything is sent. */
export async function historyDeleteMessage(convKey: string, messageId: string): Promise<HistoryDeleteResult> {
	const key = toConvKey(convKey)
	if (!isValidConvKey(key) || !isValidMessageId(messageId)) return { ok: false, code: 'bad_request' }
	const reqId = nextReqId()
	return parseHistoryDeleteAnswer(await sendShellRecordCommand(buildHistoryDeleteMessageCommand(reqId, key, messageId), TIMEOUT_MS))
}

/** Deletes one conversation and its messages. Invalid input is refused on the page, before anything is sent. */
export async function historyDeleteConversation(convKey: string): Promise<HistoryDeleteResult> {
	const key = toConvKey(convKey)
	if (!isValidConvKey(key)) return { ok: false, code: 'bad_request' }
	const reqId = nextReqId()
	return parseHistoryDeleteAnswer(await sendShellRecordCommand(buildHistoryDeleteConversationCommand(reqId, key), TIMEOUT_MS))
}
