// the delivery receipt as an event.
import { emitDeliveryReceipt, hasDeliveryReceipt, onDeliveryReceipt, resetDeliveryReceiptBusForTest } from './deliveryReceiptBus'

describe('deliveryReceiptBus', () => {
	beforeEach(() => resetDeliveryReceiptBusForTest())

	it('listeners hear the sendId; an unsubscribed listener does not; one that throws does not stop the others', () => {
		const heard: string[] = []
		const off = onDeliveryReceipt((id, from) => heard.push(`a:${id}:${from}`))
		onDeliveryReceipt(() => { throw new Error('boom') })
		onDeliveryReceipt((id, from) => heard.push(`c:${id}:${from}`))
		emitDeliveryReceipt('s1', '0xAA')
		expect(heard).toEqual(['a:s1:0xaa', 'c:s1:0xaa']) // the sender of the receipt is carried, lower case
		off()
		emitDeliveryReceipt('s2', '0xaa')
		expect(heard).toEqual(['a:s1:0xaa', 'c:s1:0xaa', 'c:s2:0xaa'])
	})

	it('a receipt is remembered for this page load, so a conversation opened later finds it; an empty id is ignored', () => {
		emitDeliveryReceipt('s1', '0xaa')
		emitDeliveryReceipt('', '0xaa')
		emitDeliveryReceipt('s3', '')
		expect(hasDeliveryReceipt('s1', '0xaa')).toBe(true)
		expect(hasDeliveryReceipt('s1', '0xAA')).toBe(true)
		expect(hasDeliveryReceipt('s1', '0xbb')).toBe(false) // the same sendId from another contact is another receipt
		expect(hasDeliveryReceipt('s2', '0xaa')).toBe(false)
		expect(hasDeliveryReceipt('', '0xaa')).toBe(false)
		expect(hasDeliveryReceipt('s3', '')).toBe(false)
	})

	it('the memory is bounded (the oldest are forgotten)', () => {
		for (let i = 0; i < 1100; i++) emitDeliveryReceipt('id' + i, '0xaa')
		expect(hasDeliveryReceipt('id0', '0xaa')).toBe(false)
		expect(hasDeliveryReceipt('id1099', '0xaa')).toBe(true)
	})
})

describe('the QA receipt trace (hook variant only)', () => {
	it('with the hook switch off nothing is recorded and nothing is exported (a production build keeps no trace)', () => {
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
		jest.resetModules()
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const bus = require('./deliveryReceiptBus') as typeof import('./deliveryReceiptBus')
		bus.emitDeliveryReceipt('send-1', '0xAbCdEf')
		bus.recordReceiptOutcome('send-1', '0xabcdef', 'applied')
		expect(bus.receiptTrace()).toEqual([])
	})
	it('with the switch on: every emit and every outcome is recorded with the last 8 / 6 characters only, codes only, at most 40 kept', () => {
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		jest.resetModules()
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const bus = require('./deliveryReceiptBus') as typeof import('./deliveryReceiptBus')
		bus.emitDeliveryReceipt('1767225600000-aaaa1111', '0x1111111111111111111111111111111111ABCDEF')
		bus.recordReceiptOutcome('1767225600000-aaaa1111', '0x1111111111111111111111111111111111abcdef', 'other_peer')
		bus.recordReceiptOutcome('x', 'y', 'A sentence, with Spaces!')
		const t = bus.receiptTrace()
		expect(t.map((e) => `${e.id}|${e.from}|${e.outcome}`).slice(0, 2)).toEqual(['aaaa1111|abcdef|emitted', 'aaaa1111|abcdef|other_peer'])
		expect(t[2].outcome).toMatch(/^[a-z_]*$/)
		for (let i = 0; i < 60; i++) bus.recordReceiptOutcome(`s${i}`, 'p', 'applied')
		expect(bus.receiptTrace().length).toBe(40)
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
	})
	it('chat.tsx records what the conversation did with each receipt: not this contact, no queue item, no message in the list, applied (durable or not)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const chat = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8') as string
		expect(chat).toMatch(/if \(!queue\.has\(sendId\)\) \{ recordReceiptOutcome\(sendId, peer, 'no_queue_item'\); return false \}/)
		expect(chat).toMatch(/if \(!m\) \{ recordReceiptOutcome\(sendId, peer, 'no_message'\); return false \}/)
		expect(chat).toMatch(/else recordReceiptOutcome\(sendId, from, 'other_peer'\)/)
		expect(chat).toMatch(/recordReceiptOutcome\(sendId, peer, persisted \? 'applied' : 'applied_not_durable'\)/)
		expect(chat).toMatch(/seen: Object\.fromEntries\(\[\.\.\.qaSeenRef\.current\.entries\(\)\]\.map\(\(\[k, v\]\) => \[k\.slice\(-8\), v\]\)\), libraryRead: qaLibraryReadRef\.current/)
	})
})
