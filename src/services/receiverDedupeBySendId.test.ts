// the receiver shows ONE message for one sendId however many times it arrives (a retry with the same armor, a store_failed node that still fanned out live, a resume after a lost
// receipt). The PWA receiver is chatMessageMerge.ts makeMessage (stableChatMessageId keyed by sendId; chat.ts re-exports it); the iOS shell has its own receiver (native module, not this test); Android's receiver dedupes by SeenArmor / sendId.
import { makeMessage } from './chatMessageMerge'

const wire = (sendId: string, text: string, createdAt: number) => JSON.stringify({ sendId, from: 'me', text, createdAt })

describe('PWA receiver: de-duplication by sendId (makeMessage)', () => {
	it('the same sendId arriving twice (even at different times) is one message', () => {
		const first = makeMessage([], wire('sid-1', 'hello', 1000), 1000, 'them', 'sent')
		expect(first).toHaveLength(1)
		const again = makeMessage(first, wire('sid-1', 'hello', 7777), 5000, 'them', 'sent') // even with another createdAt in the payload
		expect(again).toHaveLength(1)
		const third = makeMessage(again, wire('sid-1', 'hello', 8888), 9000, 'them', 'sent')
		expect(third).toHaveLength(1)
		expect(third[0].sendId).toBe('sid-1')
	})
	it('two different sendIds with the same text are two messages (the dedupe is by sendId, not by text)', () => {
		const a = makeMessage([], wire('sid-1', 'same text', 1000), 1000, 'them', 'sent')
		const b = makeMessage(a, wire('sid-2', 'same text', 1000), 2000, 'them', 'sent') // even with the same createdAt
		expect(b.map((m) => m.sendId).sort()).toEqual(['sid-1', 'sid-2'])
	})
	it('a re-delivery after a reload (the stored list is passed back in) is still one message', () => {
		const stored = makeMessage([], wire('sid-9', 'kept', 1000), 1000, 'them', 'sent')
		const reloaded = JSON.parse(JSON.stringify(stored))
		expect(makeMessage(reloaded, wire('sid-9', 'kept', 1000), 3000, 'them', 'sent')).toHaveLength(1)
	})
})
