/**
 * @jest-environment node
 */
// A reload of the sender's page shortly after the click, in two states: (S2) the box already empty and the bubble "Sending…"; (S3) the bubble already "Sent". Replayed against the REAL queue, store and
// restore of this tree. Code level, synthetic values; no browser.
import { createChatDocStores } from './chatDocStores'
import { createDraftAutosaver } from './chatDraftStore'
import { createSendQueue, type AttemptResult, type QueueDocAdapter } from './sendQueue'
import { acceptOutgoingText, messagesForUnlisted, queueItemFromDraft } from './sendFlow'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xbbbb000000000000000000000000000000000002'
const KEY = `0x${'33'.repeat(32)}`
const tick = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)) }

async function sendThenReload(answer: () => Promise<AttemptResult>) {
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
	const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc })!
	const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'awaiting', persisted: true }), persistConfirmed: async () => false, heartbeatMs: 0, retryDelaysMs: [] })
	const autosaver = createDraftAutosaver({ store: stores.draftStore, peer: PEER, enqueue: (rec) => queue.enqueue(queueItemFromDraft(rec, PEER, 1), { inline: true }), setTimer: () => 0, clearTimer: () => undefined })
	let cleared = false
	const begun = await acceptOutgoingText({ autosaver, queueReady: true, currentText: 'sample-shaped message', clearInput: () => { cleared = true }, onNotSaved: () => undefined })
	if (!begun.ok) throw new Error('not accepted')
	void queue.run(begun.sendId, answer, { inline: true })
	await tick()
	queue.dispose() // the force reload: nothing in memory survives; the account record and the library never got the message
	const again = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc })!
	const items = await again.queueStore.list()
	return { cleared, sendId: begun.sendId, listed: messagesForUnlisted(items, []) as Array<{ sendId?: string; text?: string }> }
}

it('S2 shape: reloaded while the request is still on its way (nothing else written): the sender gets the message back under the same sendId', async () => {
	const r = await sendThenReload(() => new Promise<AttemptResult>(() => undefined))
	expect([r.cleared, r.listed.length, r.listed[0]?.sendId, r.listed[0]?.text]).toEqual([true, 1, r.sendId, 'sample-shaped message'])
})
it("S3 shape: reloaded after \"Sent\" but before the sender's own copy is stored: the queue item is not released, so the sender still has it", async () => {
	for (const result of [{ kind: 'sent', persisted: false }, { kind: 'awaiting', persisted: true }, { kind: 'awaiting', persisted: false }] as AttemptResult[]) {
		const r = await sendThenReload(async () => result)
		expect([result.kind, r.listed.length, r.listed[0]?.sendId]).toEqual([result.kind, 1, r.sendId])
	}
})

describe('the acceptance answer is stored with the queue item (read by the leave lock only)', () => {
	const make = () => {
		const docs = new Map<string, string>()
		const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
		const stores = createChatDocStores({ eoa: EOA, privateKey: KEY, nativeShell: false, doc })!
		const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'awaiting', persisted: true }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
		return { docs, stores, queue }
	}
	const item = { v: 1 as const, sendId: 'r1', peer: PEER, text: 'synthetic', createdAt: 1, queuedAt: 1 }
	it('survives a reload, keeps the stored armor, never replaces a bound receipt with the weaker one, and releases nothing', async () => {
		const { stores, queue } = make()
		await queue.enqueue(item, { inline: true })
		await queue.recordArmor('r1', 'armor-1', 'digest-1')
		await queue.recordReceipt('r1', 'legacy_empty')
		expect(await stores.queueStore.get('r1')).toMatchObject({ receipt: 'legacy_empty', armor: 'armor-1', armorDigest: 'digest-1' })
		await queue.recordReceipt('r1', 'bound')
		await queue.recordReceipt('r1', 'legacy_empty')
		expect((await stores.queueStore.get('r1'))!.receipt).toBe('bound')
		expect(queue.has('r1')).toBe(true)
		expect(queue.armorOf('r1')).toBe('armor-1')
		queue.dispose()
		expect((await stores.queueStore.list())[0]!.receipt).toBe('bound')
	})
	it('an item that is gone is never written back', async () => {
		const { docs, queue } = make()
		await queue.enqueue(item, { inline: true })
		await queue.drop('r1')
		await queue.recordReceipt('r1', 'bound')
		expect([...docs.keys()].filter((k) => k.startsWith('chat-queue-v1:'))).toEqual([])
		queue.dispose()
	})
	it('the page records it for the answered POST (source check)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(src).toContain('if (sendIdOfThis && answered) await sendQueueRef.current?.recordReceipt(sendIdOfThis, answered.kind).catch(() => undefined)')
		expect(src).toContain('if (heldSid && answered) await heldQueue?.recordReceipt(heldSid, answered.kind).catch(() => undefined)')
	})
})
