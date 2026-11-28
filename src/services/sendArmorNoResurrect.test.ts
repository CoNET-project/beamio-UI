/**
 * @jest-environment node
 */
// The armor record of a send attempt never brings back a queue document that has been removed, and never writes after its queue was disposed. Real queue and queue store over an in-memory document table.
import { base64JsonCodec } from './chatDraftStore'
import { createQueueStore, createSendQueue, queueDocId, type QueueDocAdapter, type QueueItem } from './sendQueue'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const ITEM: QueueItem = { v: 1, sendId: 's1', peer: PEER, text: 'synthetic', createdAt: 1, queuedAt: 1 }
const ID = queueDocId(EOA, 's1')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rig() {
	const docs = new Map<string, string>()
	const slow = { removeMs: 0 }
	let puts = 0
	const doc: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: async (id, t) => { puts += 1; docs.set(id, t) },
		remove: async (id) => { docs.delete(id); if (slow.removeMs) await wait(slow.removeMs) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)),
	}
	const queue = createSendQueue({ store: createQueueStore({ eoa: EOA, doc, codec: base64JsonCodec() }), peer: PEER, resume: async () => ({ kind: 'unknown' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	return { docs, queue, slow, puts: () => puts }
}

describe('an armor record never brings back a removed item', () => {
	it('the user drops the message between the read of the context and the record: the record rejects and the document stays removed', async () => {
		const r = rig()
		await r.queue.enqueue(ITEM)
		const ctx = await r.queue.armorContext('s1')
		await r.queue.drop('s1')
		await expect(ctx!.record('ARMOR', 'd')).rejects.toThrow('queue_item_gone')
		expect(r.docs.has(ID)).toBe(false)
	})

	it('the item is released by its proof (sent and persisted) before the record lands: rejected, not brought back', async () => {
		const r = rig()
		await r.queue.enqueue(ITEM)
		const ctx = await r.queue.armorContext('s1')
		await r.queue.settle('s1', { kind: 'sent', persisted: true })
		await expect(ctx!.record('ARMOR', 'd')).rejects.toThrow('queue_item_gone')
		expect(r.docs.has(ID)).toBe(false)
	})

	for (const how of ['drop', 'settle'] as const) {
		it(`a record asked WHILE the removal is still running (${how}) waits for it and is rejected: no write after the removal`, async () => {
			const r = rig()
			await r.queue.enqueue(ITEM)
			const ctx = await r.queue.armorContext('s1')
			r.slow.removeMs = 30
			const removing = how === 'drop' ? r.queue.drop('s1') : r.queue.settle('s1', { kind: 'sent', persisted: true })
			await wait(5)
			await expect(ctx!.record('ARMOR', 'd')).rejects.toThrow('queue_item_gone')
			await removing
			expect(r.docs.has(ID)).toBe(false)
		})
	}

	it('the context read from the document (no slot) is also rejected while a removal runs on this queue', async () => {
		const r = rig()
		await r.queue.enqueue(ITEM)
		const other = createSendQueue({ store: createQueueStore({ eoa: EOA, doc: { read: async (id) => r.docs.get(id) ?? null, put: async (id, t) => { r.docs.set(id, t) }, remove: async (id) => { r.docs.delete(id) }, list: async () => [] }, codec: base64JsonCodec() }), peer: PEER, resume: async () => ({ kind: 'unknown' }), persistConfirmed: async () => true, heartbeatMs: 0 })
		const ctx = await other.armorContext('s1') // `other` has no slot: the disk path
		await r.queue.drop('s1')
		await expect(ctx!.record('ARMOR', 'd')).rejects.toThrow()
		expect(r.docs.has(ID)).toBe(false)
	})

	it('a queue that was disposed (account or conversation changed) writes nothing: slot path and document path', async () => {
		const r = rig()
		await r.queue.enqueue(ITEM)
		const fromSlot = await r.queue.armorContext('s1')
		r.queue.dispose()
		const before = r.docs.get(ID)
		const puts = r.puts()
		await expect(fromSlot!.record('ARMOR', 'd')).rejects.toThrow('queue_disposed')
		const fromDisk = await r.queue.armorContext('s1')
		await expect(fromDisk!.record('ARMOR', 'd')).rejects.toThrow('queue_disposed')
		expect(r.docs.get(ID)).toBe(before)
		expect(r.puts()).toBe(puts)
	})

	it('the normal path still records once, and a second context that read the same empty value is refused (one inner armor per sendId)', async () => {
		const r = rig()
		await r.queue.enqueue(ITEM)
		const a = await r.queue.armorContext('s1')
		const b = await r.queue.armorContext('s1')
		await a!.record('ARMOR-A', 'd')
		await expect(b!.record('ARMOR-B', 'd')).rejects.toThrow('armor_changed')
		expect((await r.queue.armorContext('s1'))!.armor).toBe('ARMOR-A')
		expect(r.queue.armorLockCount()).toBe(0)
	})
})
