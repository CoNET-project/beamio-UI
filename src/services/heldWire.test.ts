/**
 * @jest-environment node
 */
import { heldWireFromMessage } from './heldWire'

const base = { sendId: 's-1', from: 'me' as const, text: 'hello', createdAt: 1_700_000_000_000 }

describe('heldWireFromMessage', () => {
	it('rebuilds the text wire with the same field order a text send uses', () => {
		expect(heldWireFromMessage(base)).toBe(JSON.stringify({ sendId: 's-1', from: 'me', text: 'hello', createdAt: 1_700_000_000_000 }))
	})

	it('keeps a quote', () => {
		const quote = { id: 'q', text: 'earlier', from: 'them' as const }
		expect(JSON.parse(heldWireFromMessage({ ...base, quote }) as string)).toMatchObject({ quote })
	})

	it('does not rebuild a message from the other side, a message without sendId or time, or a non-text kind', () => {
		expect(heldWireFromMessage({ ...base, from: 'them' })).toBeNull()
		expect(heldWireFromMessage({ ...base, sendId: undefined })).toBeNull()
		expect(heldWireFromMessage({ ...base, createdAt: undefined })).toBeNull()
		expect(heldWireFromMessage({ ...base, fileMessage: {} })).toBeNull()
		expect(heldWireFromMessage({ ...base, voiceMessage: {} })).toBeNull()
		expect(heldWireFromMessage({ ...base, callRecord: {} })).toBeNull()
		expect(heldWireFromMessage({ ...base, reply: {} })).toBeNull()
	})
})
