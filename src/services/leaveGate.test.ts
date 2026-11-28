/**
 * @jest-environment node
 */
// The leave gate's rule (pure; NOT wired into any navigation yet), fed from the REAL send queue and queue store. No page, no navigation. Synthetic values.
import { leaveBlocked, leaveStateOf, type LeaveSources } from './leaveGate'
import { classifySendAnswer } from './sendAnswer'
import { decideReceipt } from './sendReceiptPolicy'
import { createChatDocStores } from './chatDocStores'
import { createSendQueue, type AttemptResult, type QueueDocAdapter } from './sendQueue'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const WALLET = `0x${'a1'.repeat(20)}`
const PEER = `0x${'b2'.repeat(20)}`
const empty = (): LeaveSources => ({ wallet: WALLET, inFlight: { read: true, count: 0 }, queue: { read: true, items: [], unreadable: 0 }, unarchived: { read: true, count: 0 } })

it('each condition alone blocks; only both empty releases', () => {
	expect(leaveStateOf(empty())).toEqual({ state: 'clear' })
	expect(leaveStateOf({ ...empty(), queue: { read: true, items: [{}], unreadable: 0 } })).toEqual({ state: 'pending', unsent: 1, unarchived: 0 })
	expect(leaveStateOf({ ...empty(), inFlight: { read: true, count: 2 } })).toEqual({ state: 'pending', unsent: 2, unarchived: 0 })
	expect(leaveStateOf({ ...empty(), unarchived: { read: true, count: 3 } })).toEqual({ state: 'pending', unsent: 0, unarchived: 3 })
	expect(leaveStateOf({ ...empty(), queue: { read: true, items: [{}], unreadable: 0 }, unarchived: { read: true, count: 1 } })).toEqual({ state: 'pending', unsent: 1, unarchived: 1 })
	expect(leaveBlocked(leaveStateOf(empty()))).toBe(false)
})
it('unknown blocks: wallet not known, any source not read or failed, an unreadable queue record', () => {
	for (const patch of [{ wallet: '' }, { inFlight: { read: false as const, why: 'starting' } }, { queue: { read: false as const, why: 'list_failed' } }, { unarchived: { read: false as const, why: 'not_wired' } }]) {
		const s = leaveStateOf({ ...empty(), ...patch })
		expect([s.state, leaveBlocked(s)]).toEqual(['unknown', true])
	}
	expect(leaveStateOf({ ...empty(), queue: { read: true, items: [], unreadable: 1 } })).toEqual({ state: 'pending', unsent: 1, unarchived: 0 })
})
it('a queue item is unsent whatever kind of answer is stored with it', () => {
	for (const items of [[{ receipt: 'legacy_empty' }], [{ receipt: 'bound' }], [{}]]) expect(leaveStateOf({ ...empty(), queue: { read: true, items, unreadable: 0 } })).toEqual({ state: 'pending', unsent: 1, unarchived: 0 })
})

function world() {
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	const stores = createChatDocStores({ eoa: WALLET, privateKey: `0x${'44'.repeat(32)}`, nativeShell: false, doc })!
	const page = () => createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	const state = async (unarchived = 0) => leaveStateOf({ ...empty(), queue: { read: true, items: await stores.queueStore.list(), unreadable: 0 }, unarchived: { read: true, count: unarchived } })
	return { stores, page, state }
}
const DIGEST = (id: string) => `0x${(id === 'a' ? 'cd' : 'ab').repeat(32)}`
/** the answer of a POST, judged by the real classification and the real release rule */
const answered = (body: string, id: string): AttemptResult => {
	const kind = classifySendAnswer(body, DIGEST(id))
	if (kind === 'reject') return { kind: 'failed' }
	return decideReceipt({ kind, digest: DIGEST(id) }) === 'confirmed' ? { kind: 'sent', persisted: true } : { kind: 'awaiting', persisted: true }
}
async function send(w: ReturnType<typeof world>, queue: ReturnType<ReturnType<typeof world>['page']>, id: string, body: string) {
	await queue.enqueue({ v: 1, sendId: id, peer: PEER, text: `synthetic ${id}`, createdAt: 1, queuedAt: id === 'a' ? 1 : 2 }, { inline: true })
	await queue.run(id, async () => {
		const kind = classifySendAnswer(body, DIGEST(id))
		if (kind !== 'reject') await queue.recordReceipt(id, kind)
		return answered(body, id)
	}, { inline: true })
}
const bound = (id: string, field = 'stored') => `{"ok":true,"${field}":true,"h":"${DIGEST(id)}"}`

describe('with the real queue: what takes an item out, and what the gate then says', () => {
	it.each([
		['an empty 2xx answer', ''],
		['a receipt of another message', bound('b')],
		['ok and the digest, without stored or duplicate', `{"ok":true,"h":"${DIGEST('a')}"}`],
		['a refusal', '{"ok":false}'],
	])('%s: the item stays and the gate stays closed, also after a restart', async (_name, body) => {
		const w = world(); const q = w.page()
		await send(w, q, 'a', body)
		q.dispose()
		const again = w.page(); await again.load()
		expect([(await w.stores.queueStore.list()).map((i) => i.sendId), await w.state()]).toEqual([['a'], { state: 'pending', unsent: 1, unarchived: 0 }])
		again.dispose()
	})
	it.each(['stored', 'duplicate'])('a bound receipt (%s) takes out THIS item only: another unsent item still closes the gate; the delivery receipt coming later changes nothing', async (field) => {
		const w = world(); const q = w.page()
		await send(w, q, 'b', '')
		await send(w, q, 'a', bound('a', field))
		expect([(await w.stores.queueStore.list()).map((i) => i.sendId), await w.state()]).toEqual([['b'], { state: 'pending', unsent: 1, unarchived: 0 }])
		await q.settle('a', { kind: 'sent', persisted: true }) // the recipient's receipt for 'a' arrives afterwards
		await q.recordReceipt('a', 'bound')
		expect((await w.stores.queueStore.list()).map((i) => i.sendId)).toEqual(['b'])
		q.dispose()
	})
	it("the recipient's receipt first, also only after a restart, releases that item only; a repeat is harmless; the late answer of the POST brings nothing back", async () => {
		const w = world(); const q = w.page()
		await send(w, q, 'a', ''); await send(w, q, 'b', '')
		q.dispose()
		const again = w.page(); await again.load()
		await again.settle('a', { kind: 'sent', persisted: true })
		await again.settle('a', { kind: 'sent', persisted: true })
		await again.recordReceipt('a', 'legacy_empty')
		expect([(await w.stores.queueStore.list()).map((i) => i.sendId), await w.state()]).toEqual([['b'], { state: 'pending', unsent: 1, unarchived: 0 }])
		await again.settle('b', { kind: 'sent', persisted: true })
		expect(await w.state()).toEqual({ state: 'clear' })
		again.dispose()
	})
	it('sending and archiving may finish in either order; one of them alone keeps the gate closed', async () => {
		const w = world(); const q = w.page()
		await send(w, q, 'a', '')
		expect(leaveBlocked(await w.state(0))).toBe(true) // archived first
		await q.settle('a', { kind: 'sent', persisted: true })
		expect(leaveBlocked(await w.state(1))).toBe(true) // sent first
		expect(leaveBlocked(await w.state(0))).toBe(false)
		q.dispose()
	})
})
