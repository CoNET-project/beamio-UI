/**
 * @jest-environment node
 */
// item 7: a message held at first contact and released by "Verify and send" must reach the local library like a normal send.
import { readFileSync } from 'fs'
import { join } from 'path'

type Row = { peer: string; dir: 'in' | 'out'; ts: number; sendId?: string; body: string }
// stands in for the worker's HistoryStore.append → local library (rows are de-duplicated by sendId, as the worker does)
const library: Row[] = []
const appendImpl = async (row: Row) => {
	if (row.sendId && library.some((r) => r.peer === row.peer && r.sendId === row.sendId)) return
	library.push(row)
}
const mockAppend = jest.fn(appendImpl)
jest.mock('./chatWorkerBridge', () => ({ appendWorkerHistory: (row: Row) => mockAppend(row) }))

import { mergeHistoryEntriesIntoMessages, mirrorVerifiedHeldSend } from './chatHistoryMirror'

const PEER = '0x00000000000000000000000000000000000000aa'
const heldMsg = (status: string): ChatMessage =>
	({ id: 'tmp_1', from: 'me', text: 'unique-body-for-test', createdAt: 1_700_000_000_000, sendId: 'send-1', status } as unknown as ChatMessage)

/** a page refresh in library mode: the page keeps no bodies, the messages come back only from the library rows */
const refresh = (): ChatMessage[] =>
	mergeHistoryEntriesIntoMessages([], library.map((r, i) => ({ seq: i, ts: r.ts, peer: r.peer, dir: r.dir, body: r.body }))).messages

describe('retryHeldSend success is mirrored', () => {
	beforeEach(() => {
		library.length = 0
		mockAppend.mockReset()
		mockAppend.mockImplementation(appendImpl) // CRA resets mocks between tests
	})

	it('a held message verified and sent is in the local library and comes back after a refresh', async () => {
		expect(mirrorVerifiedHeldSend(PEER, heldMsg('sent'), 'held_first_contact')).toBe(true)
		await Promise.resolve()
		expect(mockAppend).toHaveBeenCalledTimes(1)
		expect(mockAppend.mock.calls[0][0]).toMatchObject({ peer: PEER, dir: 'out', sendId: 'send-1' })
		const after = refresh()
		expect(after).toHaveLength(1)
		expect(after[0]).toMatchObject({ from: 'me', status: 'sent', sendId: 'send-1', text: 'unique-body-for-test' })
	})

	it('without the mirror the message would be lost (the pre-fix behaviour: nothing appended)', () => {
		expect(refresh()).toHaveLength(0)
	})

	it('is not mirrored twice: an already-sent message, a repeat call, and the worker sendId dedup', async () => {
		expect(mirrorVerifiedHeldSend(PEER, heldMsg('sent'), 'sent')).toBe(false)
		expect(mockAppend).not.toHaveBeenCalled()
		mirrorVerifiedHeldSend(PEER, heldMsg('sent'), 'held_first_contact')
		mirrorVerifiedHeldSend(PEER, heldMsg('sent'), 'held_first_contact') // even if called again, the sendId dedup keeps one row
		await Promise.resolve()
		expect(library).toHaveLength(1)
		expect(refresh()).toHaveLength(1)
	})

	it('a message that did not settle as sent is not mirrored', () => {
		expect(mirrorVerifiedHeldSend(PEER, heldMsg('failed'), 'held_first_contact')).toBe(false)
		expect(mirrorVerifiedHeldSend(PEER, undefined, 'held_first_contact')).toBe(false)
		expect(mockAppend).not.toHaveBeenCalled()
	})

	it('writes no log line (a message body never reaches a log)', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => jest.spyOn(console, k).mockImplementation(() => undefined))
		mirrorVerifiedHeldSend(PEER, heldMsg('sent'), 'held_first_contact')
		await Promise.resolve()
		for (const s of spies) {
			expect(s).not.toHaveBeenCalled()
			s.mockRestore()
		}
	})

	it('wiring: retryHeldSend calls the mirror only in its success branch, after the message is stored', () => {
		const src = readFileSync(join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')
		const start = src.indexOf('async function retryHeldSend(')
		const end = src.indexOf('// Open thread owns this peer', start)
		const body = src.slice(start, end)
		expect(body).toContain('mirrorVerifiedHeldSend(chatData.address')
		const okIdx = body.indexOf('if (ok) {', body.indexOf('await storageData()'))
		const mirrorIdx = body.indexOf('mirrorVerifiedHeldSend(')
		expect(okIdx).toBeGreaterThan(0)
		expect(mirrorIdx).toBeGreaterThan(okIdx)
		expect(body.slice(mirrorIdx)).toContain('heldSendsRef.current.delete(tempId)')
		expect((body.match(/mirrorVerifiedHeldSend\(/g) || []).length).toBe(1)
	})
})
