/**
 * -1,: an inbound line joins the ACK lists only after its chat row is written, so a throw in the mirror or the write
 * never ACKs a row that is not in the store. A repeated copy is a duplicate; a line whose signature is not valid is rejected and is
 * never passed to the settle step. Behaviour only; the steps are fakes.
 */
import {
	classifyInboundLine,
	newInboundLists,
	recordInboundLine,
	recordDroppedLine,
	recordRejectedLine,
	parseInboundLine,
	settleInputOf,
} from './inboundRowRecord'
import { settleInboundBatch, type InboundAckTarget } from './inboundBatchSettle'

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

describe('recordInboundLine', () => {
	it('a new row is recorded after its write succeeded, and the mirror ran before the write', () => {
		const order: string[] = []
		const l = newInboundLists()
		recordInboundLine(l, 'line-a', true, {
			mirror: () => order.push('mirror'),
			write: () => order.push('write'),
		})
		expect(order).toEqual(['mirror', 'write'])
		expect(l.stored).toEqual(['line-a'])
		expect(l.duplicates).toEqual([])
	})

	it('a throw in the mirror leaves the row unwritten and the line unrecorded', () => {
		const l = newInboundLists()
		const write = jest.fn()
		expect(() =>
			recordInboundLine(l, 'line-b', true, {
				mirror: () => {
					throw new Error('mirror failed')
				},
				write,
			}),
		).toThrow('mirror failed')
		expect(write).not.toHaveBeenCalled()
		expect(l.stored).toEqual([])
	})

	it('a throw in the write leaves the line unrecorded', () => {
		const l = newInboundLists()
		expect(() =>
			recordInboundLine(l, 'line-c', true, {
				write: () => {
					throw new Error('write failed')
				},
			}),
		).toThrow('write failed')
		expect(l.stored).toEqual([])
		expect(l.duplicates).toEqual([])
	})

	it('a duplicate copy is recorded apart from new rows and never runs the mirror', () => {
		const l = newInboundLists()
		const mirror = jest.fn()
		recordInboundLine(l, 'line-d', false, { mirror, write: () => undefined })
		expect(mirror).not.toHaveBeenCalled()
		expect(l.stored).toEqual([])
		expect(l.duplicates).toEqual(['line-d'])
	})
})

describe('the settle input of a batch', () => {
	it('a rejected line is not in the settle input; a dropped line is', () => {
		const l = newInboundLists()
		recordRejectedLine(l, 'bad-signature')
		recordDroppedLine(l, 'control')
		const input = settleInputOf(l)
		expect(input.dropLines).toEqual(['control'])
		expect(JSON.stringify(input)).not.toContain('bad-signature')
	})
})

describe('parseInboundLine', () => {
	it('returns the object for JSON and null for text that is not JSON', () => {
		expect(parseInboundLine('{"a":1}')).toEqual({ a: 1 })
		expect(parseInboundLine('{"text": not json')).toBeNull()
		expect(parseInboundLine('')).toBeNull()
	})
})

describe('a line whose row never got written is not ACKed (-1 with the settle step)', () => {
	it('mirror throws: the line is not in the row list, so the native page sends no ackInbound for it', async () => {
		const l = newInboundLists()
		try {
			recordInboundLine(l, 'line-e', true, {
				mirror: () => {
					throw new Error('mirror failed')
				},
				write: () => undefined,
			})
		} catch {
			/* the App catch: logged, not stored, not ACKed */
		}
		const displayed: string[][] = []
		const target: InboundAckTarget = {
			browser: false,
			alreadyAcked: () => false,
			ackMailbox: () => undefined,
			ackDisplayed: (hashes) => displayed.push(hashes),
		}
		const hashByLine: Record<string, string> = { 'line-e': H(30) }
		await settleInboundBatch(settleInputOf(l), {
			target,
			hashesOf: (lines) => lines.map((x) => hashByLine[x]).filter((h): h is string => !!h),
			markHashes: () => [],
			unmarkHashes: () => undefined,
			commit: async () => true,
			release: () => undefined,
		})
		expect(displayed).toEqual([])
	})
})

describe('classifyInboundLine', () => {
	it('text that is not JSON is unparseable (a dropped frame: marker, then ACK)', () => {
		expect(classifyInboundLine('{"text": not json').kind).toBe('unparseable')
		expect(classifyInboundLine('null').kind).toBe('unparseable')
	})

	it('a JSON object without signMessage is rejected, not dropped', () => {
		expect(classifyInboundLine(JSON.stringify({ text: 'hello', from: '0x1' })).kind).toBe('rejected')
	})

	it('a JSON object without text is rejected, not dropped', () => {
		expect(classifyInboundLine(JSON.stringify({ signMessage: '0x12', from: '0x1' })).kind).toBe('rejected')
	})

	it('JSON that is not an object (number, string, array) is rejected', () => {
		for (const raw of ['123', '"text"', '[1,2]', 'true']) expect(classifyInboundLine(raw).kind).toBe('rejected')
	})

	it('a JSON object with text and signMessage goes on to the signature check', () => {
		const c = classifyInboundLine(JSON.stringify({ text: 'hello', signMessage: '0x12', from: '0x1' }))
		expect(c.kind).toBe('signed')
	})
})

