/**
 * @jest-environment node
 */
// A message sent from outside a conversation page (gift note and gift card): the real queue, queue store and restore. Synthetic values; the "claim link" is a marker string.
import { createChatDocStores } from './chatDocStores'
import { createSendQueue, type QueueDocAdapter } from './sendQueue'
import { messagesForUnlisted } from './sendFlow'
import { heldWireFromMessage } from './heldWire'
import { pendingCountOf, resetPendingSendsForTest } from './pendingSends'
import { sendQueuedCards, type CardSendDeps, type CardSendEntry } from './queuedCardSend'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xbbbb000000000000000000000000000000000002'
const LINK = 'synthetic-claim-link-marker'
const DIGEST = `0x${'cd'.repeat(32)}`
type Msg = { id: string; sendId: string; from: 'me'; text: string; createdAt: number; status: string; sendError?: string; paymentCard?: unknown }
const note: Msg = { id: 'n1', sendId: 'n1', from: 'me', text: 'synthetic note', createdAt: 10, status: 'sending' }
const card: Msg = { id: 'c1', sendId: 'c1', from: 'me', text: '', createdAt: 11, status: 'sent', paymentCard: { cashcodeUrl: LINK } }
const entries = (): CardSendEntry<Msg>[] => [
	{ sendId: 'n1', createdAt: 10, text: note.text, payload: JSON.stringify({ sendId: 'n1', from: 'me', text: note.text, createdAt: 10 }), message: { ...note } },
	{ sendId: 'c1', createdAt: 11, text: '', payload: JSON.stringify(card), message: { ...card, status: 'sending' } },
]
beforeEach(() => resetPendingSendsForTest())

function world() {
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	const stores = createChatDocStores({ eoa: EOA, privateKey: `0x${'33'.repeat(32)}`, nativeShell: false, doc })!
	const seen = { list: [] as Msg[], statuses: [] as string[], posted: [] as string[], archived: [] as string[], onDiskAtShow: -1, persisted: 0 }
	const deps = (over: Partial<CardSendDeps<Msg>> = {}): CardSendDeps<Msg> => ({
		wallet: EOA, peer: PEER, store: stores.queueStore,
		show: (m) => { seen.list = [...seen.list, ...m]; seen.onDiskAtShow = [...docs.keys()].filter((k) => k.startsWith('chat-queue-v1:')).length },
		setStatus: (id, status, sendError) => { seen.statuses.push(`${id}:${status}`); seen.list = seen.list.map((m) => (m.sendId === id ? { ...m, status, sendError } : m)) },
		persist: async () => { seen.persisted += 1 },
		transmit: async (payload, armor) => { await armor!.record(`armor-of-${seen.posted.length}`, 'digest'); seen.posted.push(payload); return true },
		archive: async (m) => { seen.archived.push(m.sendId); return true },
		...over,
	})
	/** the next page: what the conversation reads back from the queue */
	const reload = async () => {
		const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
		const items = await queue.load()
		const restored = messagesForUnlisted(items, []) as unknown as Msg[]
		queue.dispose()
		return { items, restored }
	}
	return { docs, stores, seen, deps, reload }
}

it('every item is on disk before anything is shown; with an empty 200 both turn sent and BOTH stay in the queue with their armor', async () => {
	const w = world()
	const r = await sendQueuedCards(entries(), w.deps({ transmit: async (p, armor, onReceipt) => { await armor!.record('armor', 'digest'); w.seen.posted.push(p); onReceipt({ kind: 'legacy_empty', digest: DIGEST }); return true } }))
	expect([r.sent, r.failed, w.seen.onDiskAtShow, w.seen.list.map((m) => m.status)]).toEqual([['n1', 'c1'], [], 2, ['sent', 'sent']])
	expect((await w.stores.queueStore.list()).map((i) => [i.sendId, i.armor, i.receipt])).toEqual([['n1', 'armor', 'legacy_empty'], ['c1', 'armor', 'legacy_empty']])
	expect(w.docs.size).toBe(2)
	for (const stored of w.docs.values()) expect(stored).not.toContain(LINK) // sealed in the browser
	expect(pendingCountOf(EOA)).toBe(0)
})
it('the first succeeds and the second fails: the failed card is never shown as sent, stays queued, and comes back after a reload with the same sendId and payload', async () => {
	const w = world()
	let n = 0
	const r = await sendQueuedCards(entries(), w.deps({ transmit: async (p) => { w.seen.posted.push(p); return n++ === 0 } }))
	expect([r.sent, r.failed]).toEqual([['n1'], ['c1']])
	expect(w.seen.statuses).toEqual(['n1:sent', 'c1:failed'])
	expect(w.seen.archived).not.toContain('c1')
	const after = await w.reload()
	expect(after.items.map((i) => i.sendId)).toEqual(['n1', 'c1'])
	expect(after.items[1]!.wire).toBe(entries()[1]!.payload)
	expect(after.restored[1]!.paymentCard).toEqual({ cashcodeUrl: LINK })
	// the note is rebuilt from its text as the very payload that was posted
	expect(heldWireFromMessage(after.restored[0]!)).toBe(entries()[0]!.payload)
})
it('the page closes while the first request is on its way (the account record keeps no bodies): both messages are in the queue, and the send is counted as unsent', async () => {
	const w = world()
	void sendQueuedCards(entries(), w.deps({ transmit: () => new Promise<boolean>(() => undefined) }))
	for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r))
	expect(pendingCountOf(EOA)).toBe(1)
	const after = await w.reload()
	expect([after.items.map((i) => i.sendId), after.restored.length, w.seen.list.map((m) => m.status)]).toEqual([['n1', 'c1'], 2, ['sending', 'sending']])
})
it('an account record that cannot be written: nothing leaves, both are failed and stay queued', async () => {
	const w = world()
	const r = await sendQueuedCards(entries(), w.deps({ persist: async () => { throw new Error('disk') } }))
	expect([r.sent, r.failed, w.seen.posted, w.seen.list.map((m) => m.status), (await w.stores.queueStore.list()).length]).toEqual([[], ['n1', 'c1'], [], ['failed', 'failed'], 2])
})
it('a queue that cannot be written: not shown, not sent', async () => {
	const w = world()
	const r = await sendQueuedCards(entries(), w.deps({ store: { ...w.stores.queueStore, put: async () => { throw new Error('quota') } } }))
	expect([r.accepted, r.notAccepted, w.seen.list, w.seen.posted]).toEqual([[], ['n1', 'c1'], [], []])
})
it('a bound receipt releases an item only with the history copy confirmed', async () => {
	for (const archiveOk of [true, false]) {
		const w = world()
		await sendQueuedCards([entries()[1]!], w.deps({ transmit: async (_p, _a, onReceipt) => { onReceipt({ kind: 'bound', digest: DIGEST }); return true }, archive: async () => archiveOk }))
		expect([archiveOk, (await w.stores.queueStore.list()).length]).toEqual([archiveOk, archiveOk ? 0 : 1])
	}
})
