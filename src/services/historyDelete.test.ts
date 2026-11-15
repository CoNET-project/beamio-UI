/**
 * ( to): the page's history delete client. A message delete removes one message; a conversation delete removes
 * only that conversation; neither writes the page record; the answer is one ack matched by reqId; invalid input is refused on the page.
 */
import { historyDeleteConversation, historyDeleteMessage, isValidConvKey, isValidMessageId } from './historyDelete'
import { nextReqId } from './nativeChatRouteRegister'
import { sendShellRecordCommand } from './shellRecordTransport'

jest.mock('./shellRecordTransport', () => ({
	sendShellRecordCommand: jest.fn(),
}))
jest.mock('./nativeChatRouteRegister', () => ({
	nextReqId: jest.fn(() => 42),
}))

const CONV = '0x' + 'a'.repeat(40)
const ack = (result: Record<string, unknown>) => ({ kind: 'payload', payload: { type: 'ack', reqId: 42, ok: true, result } })

beforeEach(() => {
	;(sendShellRecordCommand as jest.Mock).mockReset()
	// CRA resets mock implementations before each test: the reqId source is set again here.
	;(nextReqId as jest.Mock).mockReturnValue(42)
})

describe('DL: history delete', () => {
	it('a message delete sends only the message: type, reqId, convKey and messageId; no page record write', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: true }))
		expect(await historyDeleteMessage(CONV, 'sendKey-1')).toEqual({ ok: true, deleted: true })
		expect((sendShellRecordCommand as jest.Mock).mock.calls[0][0]).toEqual({ type: 'historyDeleteMessage', reqId: 42, convKey: CONV, messageId: 'sendKey-1' })
		expect((sendShellRecordCommand as jest.Mock).mock.calls[0][1]).toBe(10_000)
		expect((sendShellRecordCommand as jest.Mock).mock.calls.map((c) => c[0].type)).not.toContain('shellRecordWrite')
	})

	it('a message that is missing or already a tombstone is deleted: false (idempotent)', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: false }))
		expect(await historyDeleteMessage(CONV, 'sendKey-9')).toEqual({ ok: true, deleted: false })
	})

	it('a conversation delete sends convKey only; a missing conversation is deleted: false', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: true }))
		expect(await historyDeleteConversation(CONV)).toEqual({ ok: true, deleted: true })
		expect((sendShellRecordCommand as jest.Mock).mock.calls[0][0]).toEqual({ type: 'historyDeleteConversation', reqId: 42, convKey: CONV })
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: false }))
		expect(await historyDeleteConversation(CONV)).toEqual({ ok: true, deleted: false })
	})

	it('content-level bad_request is returned with the path names', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'bad_request', names: ['messageId'] }))
		expect(await historyDeleteMessage(CONV, 'sendKey-1')).toEqual({ ok: false, code: 'bad_request', names: ['messageId'] })
	})

	it('an envelope-level bad_request (ok: false) is the code', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'payload', payload: { type: 'ack', reqId: null, ok: false, error: 'bad_request' } })
		expect(await historyDeleteConversation(CONV)).toEqual({ ok: false, code: 'bad_request' })
	})

	it('a busy native history answers busy and changes nothing', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'busy' }))
		expect(await historyDeleteConversation(CONV)).toEqual({ ok: false, code: 'busy' })
	})

	it('a transport outcome is returned as the code (timeout, origin_refused, not_supported)', async () => {
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'timeout' })
		expect(await historyDeleteMessage(CONV, 'sendKey-1')).toEqual({ ok: false, code: 'timeout' })
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce({ kind: 'origin_refused' })
		expect(await historyDeleteConversation(CONV)).toEqual({ ok: false, code: 'origin_refused' })
	})

	it('invalid input is refused on the page: nothing is sent', async () => {
		expect(await historyDeleteConversation('0xABC')).toEqual({ ok: false, code: 'bad_request' })
		expect(await historyDeleteMessage(CONV, '')).toEqual({ ok: false, code: 'bad_request' })
		expect(await historyDeleteMessage(CONV, 'has space')).toEqual({ ok: false, code: 'bad_request' })
		expect(await historyDeleteMessage(CONV, 'x'.repeat(129))).toEqual({ ok: false, code: 'bad_request' })
		expect(sendShellRecordCommand).not.toHaveBeenCalled()
	})

	it('the id rules: a 0x address of 40 lower-case hex digits; a message id of 1 to 128 visible ASCII characters', () => {
		expect(isValidConvKey(CONV)).toBe(true)
		expect(isValidConvKey('0x' + 'A'.repeat(40))).toBe(false)
		expect(isValidMessageId('a'.repeat(128))).toBe(true)
		expect(isValidMessageId('a'.repeat(129))).toBe(false)
	})

	it('a checksum-form conversation address is accepted and sent in lower case (the command takes lower case)', async () => {
		const checksum = '0x' + 'A'.repeat(40).replace(/A/g, 'a').replace('a', 'A')
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: true }))
		expect(await historyDeleteConversation(checksum)).toEqual({ ok: true, deleted: true })
		expect((sendShellRecordCommand as jest.Mock).mock.calls[0][0].convKey).toBe(checksum.toLowerCase())
		;(sendShellRecordCommand as jest.Mock).mockResolvedValueOnce(ack({ code: 'ok', deleted: false }))
		expect(await historyDeleteMessage(checksum, 'sendKey-2')).toEqual({ ok: true, deleted: false })
		expect((sendShellRecordCommand as jest.Mock).mock.calls[1][0].convKey).toBe(checksum.toLowerCase())
		expect((sendShellRecordCommand as jest.Mock).mock.calls[1][0].messageId).toBe('sendKey-2')
	})

	it('a conversation address that is not 0x and 40 hex digits is still refused on the page', async () => {
		expect(await historyDeleteConversation('0x' + 'a'.repeat(39))).toEqual({ ok: false, code: 'bad_request' })
		expect(sendShellRecordCommand).not.toHaveBeenCalled()
	})
})
