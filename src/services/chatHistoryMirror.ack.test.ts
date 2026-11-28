/**
 * @jest-environment node
 */
// mirrorChatMessageToHistoryAck is the page side of the library ACK. Its answer is the worker's answer; it never short-circuits to true, and it skips what must not be mirrored.
const mockAck = jest.fn(async (_e: unknown) => true)
jest.mock('./chatWorkerBridge', () => ({ appendWorkerHistory: jest.fn(), appendWorkerHistoryAck: (e: unknown) => mockAck(e) }))

import { mirrorChatMessageToHistoryAck } from './chatHistoryMirror'

const PEER = '0x00000000000000000000000000000000000000AA'
const msg = (over: Record<string, unknown> = {}) => ({ id: 'tmp_1', from: 'me', text: 'body-for-test', createdAt: 1_700_000_000_000, sendId: 'send-1', status: 'sent', ...over }) as unknown as ChatMessage

beforeEach(() => mockAck.mockReset().mockResolvedValue(true))

describe('mirrorChatMessageToHistoryAck', () => {
	it('the answer is the worker\'s answer: ACK true, ACK false, and a worker that rejects', async () => {
		mockAck.mockResolvedValueOnce(true)
		expect(await mirrorChatMessageToHistoryAck(PEER, msg(), 'out')).toBe(true)
		mockAck.mockResolvedValueOnce(false)
		expect(await mirrorChatMessageToHistoryAck(PEER, msg(), 'out')).toBe(false)
		mockAck.mockRejectedValueOnce(new Error('boom'))
		await expect(mirrorChatMessageToHistoryAck(PEER, msg(), 'out')).rejects.toThrow() // the caller (ackSenderCopyToLibrary / senderCopyDurable) turns a rejection into "not durable"
	})
	it('the entry the worker gets: lower-case peer, direction, sendId, the createdAt as ts, the message JSON as body', async () => {
		await mirrorChatMessageToHistoryAck(PEER, msg(), 'out')
		expect(mockAck).toHaveBeenCalledTimes(1)
		const e = mockAck.mock.calls[0][0] as { peer: string; dir: string; ts: number; sendId: string; body: string }
		expect(e.peer).toBe(PEER.toLowerCase())
		expect(e.dir).toBe('out')
		expect(e.ts).toBe(1_700_000_000_000)
		expect(e.sendId).toBe('send-1')
		expect(JSON.parse(e.body).text).toBe('body-for-test')
	})
	it('no peer or no message: false and nothing is sent', async () => {
		expect(await mirrorChatMessageToHistoryAck('', msg(), 'out')).toBe(false)
		expect(await mirrorChatMessageToHistoryAck(undefined, msg(), 'out')).toBe(false)
		expect(await mirrorChatMessageToHistoryAck(PEER, undefined, 'out')).toBe(false)
		expect(mockAck).not.toHaveBeenCalled()
	})
	it('a local tmp_ message that is not in the settled `sent` state is not mirrored and is not an ACK (sending, failed, held)', async () => {
		for (const status of ['sending', 'failed', 'route_unconfirmed', 'fingerprint_changed', 'first_fetch_pending']) {
			expect(await mirrorChatMessageToHistoryAck(PEER, msg({ status }), 'out')).toBe(false)
		}
		expect(mockAck).not.toHaveBeenCalled()
		expect(await mirrorChatMessageToHistoryAck(PEER, msg({ id: 'real-id', status: 'delivered' }), 'out')).toBe(true) // a non-tmp id is not subject to the rule
	})
	it('a body that cannot be serialised is not an ACK and nothing is sent', async () => {
		const cyclic: Record<string, unknown> = { id: 'x', from: 'me', text: 't', createdAt: 1, status: 'sent' }
		cyclic.self = cyclic
		expect(await mirrorChatMessageToHistoryAck(PEER, cyclic as unknown as ChatMessage, 'out')).toBe(false)
		expect(mockAck).not.toHaveBeenCalled()
	})
})
