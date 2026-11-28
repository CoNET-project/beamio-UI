/**
 * @jest-environment node
 */
import { armorContextFor, noteArmorContextUnreadable } from './sendArmorContext'

const ctx = { armor: 'A', record: async () => undefined }

describe('armorContextFor: the sendId and the armor context of one text send', () => {
	it('the row sendId wins; the context is the queue\'s for that sendId', async () => {
		const seen: string[] = []
		const queue = { armorContext: async (id: string) => { seen.push(id); return ctx } }
		const r = await armorContextFor({ rowSendId: 'row-1', wire: JSON.stringify({ sendId: 'wire-1' }), queue })
		expect(r).toEqual({ sendId: 'row-1', ctx })
		expect(seen).toEqual(['row-1'])
	})
	it('no row (the list was rebuilt): the sendId inside the wire is used', async () => {
		const queue = { armorContext: async (id: string) => (id === 'wire-1' ? ctx : undefined) }
		for (const rowSendId of [undefined, null, '', '  ']) expect((await armorContextFor({ rowSendId, wire: JSON.stringify({ sendId: 'wire-1', text: 'x' }), queue })).sendId).toBe('wire-1')
	})
	it('no sendId anywhere, or no queue: no context (known gap: nothing can be reused without a queue)', async () => {
		const queue = { armorContext: async () => ctx }
		expect(await armorContextFor({ rowSendId: undefined, wire: 'not json', queue })).toEqual({ sendId: null, ctx: undefined })
		expect(await armorContextFor({ rowSendId: 's', wire: '{}', queue: null })).toEqual({ sendId: 's', ctx: undefined })
	})
	it('a queue that throws (unreadable document) makes the call throw: the caller holds the attempt back', async () => {
		const queue = { armorContext: async () => { throw new Error('queue_item_unreadable') } }
		await expect(armorContextFor({ rowSendId: 's', wire: '{}', queue })).rejects.toThrow('queue_item_unreadable')
	})
	it('the unreadable counter counts and logs a content-free line', () => {
		const lines: string[] = []
		const a = noteArmorContextUnreadable((l) => lines.push(l))
		const b = noteArmorContextUnreadable((l) => lines.push(l))
		expect(b).toBe(a + 1)
		expect(lines[1]).toBe(`[send] armor_context_unreadable n=${b}`)
	})
})

describe('chat.tsx wiring: the held retry and the ordinary send both take the armor context of their sendId', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const chat: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('held retry: reads the context, does not send when it cannot be read, hands it to the send', () => {
		expect(chat).toContain('try { heldArmor = (await armorContextFor({ rowSendId: heldSid, wire: held.text, queue: heldQueue })).ctx } catch { heldArmorUnreadable = true; noteArmorContextUnreadable() }')
		expect(chat).toContain('const ok = heldArmorUnreadable ? false : await sendChatToRecipient(held.text, { viaCachedRoute: effective === \'cached\', pinned, armor: heldArmor, onReceipt:')
	})
	it('ordinary send and retry: the same', () => {
		expect(chat).toContain('const got = await armorContextFor({ rowSendId: (messagesRef.current || []).find(x => x.id === tempId)?.sendId, wire, queue: sendQueueRef.current })')
		expect(chat).toContain('else ok = await sendChatToRecipient(wire, { armor: armorCtx, onReceipt:')
	})
})
