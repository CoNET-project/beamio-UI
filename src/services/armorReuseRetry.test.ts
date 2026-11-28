/**
 * @jest-environment node
 */
// one message, many attempts (rejected, retried, page reloaded, recovered): ONE inner armor, stored once at the endpoint.
// The real sendMessage, the real send queue and the real queue store over an in-memory document table; the endpoint stub counts stored per inner armor.
const nodeUtil = require('util')
Object.assign(globalThis, { TextEncoder: nodeUtil.TextEncoder, TextDecoder: nodeUtil.TextDecoder }, require('stream/web'))
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) (globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto

const deepStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : jest.fn()) })
jest.mock('@/services/chatWorkerBridge', () => deepStub())
jest.mock('@/services/chatMediaWorkerBridge', () => deepStub())
jest.mock('@/services/argon2WorkerBridge', () => deepStub())
jest.mock('@/workers/beamioTag/client', () => deepStub())
jest.mock('@/workers/appDaemon/client', () => deepStub())
jest.mock('pdfjs-dist', () => deepStub())
jest.mock('@/services/passcode/chatAccessGuard', () => ({ chatAccessRefused: () => false }))
jest.mock('@/services/nativeSigning', () => ({ signAccountMessageFor: async () => '0xsig' }))
jest.mock('@/services/gossipAckSign', () => ({ accountEoaFor: () => '0x00000000000000000000000000000000000000aa' }))
jest.mock('@conet.project/chat-sdk', () => ({
	hasEntryPgpKey: () => true,
	wrapArmorToEntryRoute: async (a: string) => a,
	// the wrap carries the inner armor as it is; the endpoint stub peels it
	wrapArmorToMailboxWork: async (a: string) => `WRAP<<${a}>>`,
}))

import { generateKey } from 'openpgp'
import { armorDigest } from './sendAnswer'
import { armorContextFor, noteArmorContextUnreadable } from './sendArmorContext'
import { createQueueStore, createSendQueue, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { base64JsonCodec } from './chatDraftStore'

const chat = require('./chat') as typeof import('./chat')

const PEER = '0xcccc000000000000000000000000000000000003'
const EOA = '0xabc0000000000000000000000000000000000001'
const NODES = ['n1', 'n2', 'n3', 'n4', 'n5'].map((d) => ({ domain: d, ip_addr: '1.1.1.1', region: 'x', armoredPublicKey: '', nftNumber: '1', pgpKeyID: '' })) as never

/** the endpoint: counts, per inner armor, how many times each outcome was answered */
function makeEndpoint() {
	const state = { mode: 'store_failed' as 'store_failed' | 'ok', stored: new Map<string, number>(), seen: new Map<string, number>(), posts: 0 }
	const fetchStub = async (_url: string, init: { body: string }) => {
		state.posts += 1
		const wrapped = JSON.parse(init.body).data as string
		const inner = wrapped.replace(/^WRAP<</, '').replace(/>>$/, '')
		const h = armorDigest(inner)
		state.seen.set(h, (state.seen.get(h) ?? 0) + 1)
		if (state.mode === 'store_failed') return { ok: true, text: async () => JSON.stringify({ ok: false, error: 'store_failed' }) }
		const first = !state.stored.has(h)
		state.stored.set(h, (state.stored.get(h) ?? 0) + (first ? 1 : 0))
		return { ok: true, text: async () => JSON.stringify({ ok: true, stored: first, duplicate: !first, h }) }
	}
	return { state, fetchStub }
}


type Disk = Map<string, string>
const diskFault = { readFails: false }
/** put hook: per call a delay and an optional failure; counts the writes that run at the same time */
const putHook: { plan: Array<{ ms: number; fail?: boolean }>; running: number; max: number; calls: number } = { plan: [], running: 0, max: 0, calls: 0 }
const makeDoc = (disk: Disk): QueueDocAdapter => ({
	read: async (id) => { if (diskFault.readFails) throw new Error('idb_read_failed'); return disk.get(id) ?? null },
	put: async (id, t) => {
		const step = putHook.plan.shift()
		if (!step) { disk.set(id, t); return }
		putHook.calls += 1; putHook.running += 1; putHook.max = Math.max(putHook.max, putHook.running)
		await new Promise((r) => setTimeout(r, step.ms))
		putHook.running -= 1
		if (step.fail) throw new Error('idb_put_failed')
		disk.set(id, t)
	},
	remove: async (id) => { disk.delete(id) },
	list: async (p) => [...disk.keys()].filter((k) => k.startsWith(p)),
})

/** polls until `cond` holds (the queue's attempts run in the background; a fixed sleep is not reliable under load) */
const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
	const t0 = Date.now()
	while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10))
}
/** one trigger, and wait until the attempt it started has really posted and the queue is idle again */
const fire = async (endpoint: { state: { posts: number } }, q: { snapshot(): Array<{ state: string }> }, trigger: () => void): Promise<void> => {
	const before = endpoint.state.posts
	trigger()
	await until(() => endpoint.state.posts > before, 800) // a trigger may legitimately start nothing (back-off); the totals are asserted at the end
	await until(() => q.snapshot().every((x) => x.state !== 'inflight'))
	await new Promise((r) => setTimeout(r, 5))
}

jest.setTimeout(30000)

describe('armor reuse across rejected attempts, retries, a forced reload and recovery', () => {
	let keyPublic = ''
	let route = ''
	beforeAll(async () => {
		keyPublic = (await generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: 'peer' }] })).publicKey
		route = (await generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: 'route' }] })).publicKey
	})

	/** one page load: a queue over the shared disk; `attempt` is chat.tsx deliverTextInner (armorCtx from the queue, then the real sendMessage) */
	function page(disk: Disk) {
		const store = createQueueStore({ eoa: EOA, doc: makeDoc(disk), codec: base64JsonCodec() })
		const timers: Array<() => void> = []
		let queueRef: ReturnType<typeof createSendQueue>
		const deliver = async (sendId: string): Promise<{ kind: 'sent'; persisted: boolean } | { kind: 'failed' } | { kind: 'awaiting'; persisted: boolean }> => {
			const q = queueRef
			// chat.tsx deliverTextInner: a document that cannot be read holds the attempt back (counted, nothing is sent)
			let armorCtx: Awaited<ReturnType<typeof q.armorContext>>
			try { armorCtx = (await armorContextFor({ rowSendId: sendId, wire: '{}', queue: q })).ctx } catch { noteArmorContextUnreadable(() => undefined); return { kind: 'failed' } }
			let receipt: { kind: string } | null = null
			const ok = await chat.sendMessage(keyPublic, JSON.stringify({ sendId, text: 'hello' }), 'KEY', NODES, { recipientRouteArmored: route, armor: armorCtx, onReceipt: (r) => { receipt = r } })
			if (!ok) return { kind: 'failed' }
			return receipt && (receipt as { kind: string }).kind === 'bound' ? { kind: 'sent', persisted: true } : { kind: 'awaiting', persisted: true }
		}
		queueRef = createSendQueue({
			store, peer: PEER, persistConfirmed: async () => true, isOnline: () => true, isVisible: () => true,
			setTimer: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimer: () => undefined, retryDelaysMs: [1, 1, 1],
			resume: (item: QueueItem) => deliver(item.sendId),
		} as never)
		return { queue: queueRef, deliver, timers }
	}

	it('rejected, retried by every trigger, reloaded, recovered: one inner armor, stored once', async () => {
		const endpoint = makeEndpoint()
		;(globalThis as { fetch?: unknown }).fetch = (url: string, init: { body: string }) => (String(url).endsWith('/post') ? endpoint.fetchStub(url, init) : Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }))
		const disk: Disk = new Map()
		let p = page(disk)
		const item: QueueItem = { v: 1, sendId: 'sid-1', peer: PEER, text: 'hello', createdAt: 1, queuedAt: 1 }
		await p.queue.enqueue(item, { inline: true })
		await p.queue.run('sid-1', () => p.deliver('sid-1'), { inline: true }) // first attempt (rejected)
		for (const trigger of ['manual', 'online', 'visible', 'heartbeat'] as const) await fire(endpoint, p.queue, () => p.queue.kick(trigger))
		for (let i = 0; i < 3; i++) await fire(endpoint, p.queue, () => { for (const f of p.timers.splice(0)) f(); p.queue.kick('timer') })
		p.queue.dispose()
		// forced reload: a new queue on the same disk
		p = page(disk)
		await p.queue.load()
		await fire(endpoint, p.queue, () => p.queue.kick('load'))
		await fire(endpoint, p.queue, () => p.queue.kick('manual'))
		const postsWhileRejected = endpoint.state.posts
		expect(postsWhileRejected).toBeGreaterThan(8) // many attempts really happened
		// recovery
		endpoint.state.mode = 'ok'
		for (let i = 0; i < 3; i++) await fire(endpoint, p.queue, () => p.queue.kick('manual'))
		p.queue.dispose()
		expect(endpoint.state.seen.size).toBe(1)
		expect([...endpoint.state.stored.values()].reduce((a, b) => a + b, 0)).toBe(1)
		// the bound receipt for the one armor released the item: its document is gone
		expect(disk.size).toBe(0)
	})

	const install = (endpoint: ReturnType<typeof makeEndpoint>) => {
		;(globalThis as { fetch?: unknown }).fetch = (url: string, init: { body: string }) => (String(url).endsWith('/post') ? endpoint.fetchStub(url, init) : Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' }))
	}
	const item = (sendId: string): QueueItem => ({ v: 1, sendId, peer: PEER, text: 'hello', createdAt: 1, queuedAt: 1 })

	it('an attempt that finds NO slot in memory (the queue was rebuilt and has not loaded yet) still posts the stored armor and never writes a second one', async () => {
		const endpoint = makeEndpoint(); install(endpoint)
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-2'), { inline: true })
		await a.queue.run('sid-2', () => a.deliver('sid-2'), { inline: true })
		a.queue.dispose()
		const b = page(disk) // a new queue: its slots are empty (load() not run)
		expect(b.queue.has('sid-2')).toBe(false)
		for (let i = 0; i < 3; i++) await b.deliver('sid-2')
		expect(endpoint.state.posts).toBeGreaterThanOrEqual(8)
		b.queue.dispose()
		expect(endpoint.state.seen.size).toBe(1)
	})

	it('the FIRST armor made by an attempt that has no slot is written into the item\'s document (and the next attempt, in another page load, posts it)', async () => {
		const endpoint = makeEndpoint(); install(endpoint)
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-4'), { inline: true }) // the document exists, no armor yet
		a.queue.dispose()
		const b = page(disk) // no slot
		expect(b.queue.has('sid-4')).toBe(false)
		await b.deliver('sid-4')
		const stored = JSON.parse(Buffer.from([...disk.values()][0], 'base64').toString()).item as QueueItem
		expect(typeof stored.armor).toBe('string')
		expect(stored.armorDigest).toBe(armorDigest(stored.armor as string))
		b.queue.dispose()
		const c = page(disk); await c.queue.load()
		await c.deliver('sid-4'); await c.deliver('sid-4')
		c.queue.dispose()
		expect(endpoint.state.seen.size).toBe(1)
	})

	it('two concurrent attempts with no slot: one armor is stored and sent, the other is not sent (compare-and-write); the next attempt reuses the stored one', async () => {
		const endpoint = makeEndpoint(); install(endpoint); endpoint.state.mode = 'ok'
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-5'), { inline: true }) // a document with no armor
		a.queue.dispose()
		const b = page(disk)
		expect(b.queue.has('sid-5')).toBe(false)
		const results = await Promise.all([b.deliver('sid-5'), b.deliver('sid-5')])
		expect(endpoint.state.seen.size).toBe(1) // never two inner armors for one sendId
		expect(results.filter((r) => r.kind === 'failed')).toHaveLength(1) // the loser sent nothing
		expect(endpoint.state.posts).toBe(1)
		await b.deliver('sid-5'); await b.deliver('sid-5')
		b.queue.dispose()
		expect(endpoint.state.seen.size).toBe(1)
	})

	it('(slot): two concurrent attempts WITH a slot: one armor is stored and sent, the other is not sent', async () => {
		const endpoint = makeEndpoint(); install(endpoint); endpoint.state.mode = 'ok'
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-7'), { inline: true })
		expect(a.queue.has('sid-7')).toBe(true)
		const results = await Promise.all([a.deliver('sid-7'), a.deliver('sid-7')])
		expect(endpoint.state.seen.size).toBe(1)
		expect(endpoint.state.posts).toBe(1)
		expect(results.filter((r) => r.kind === 'failed')).toHaveLength(1)
		a.queue.dispose()
	})

	it('recordArmor (the public method) is the same compare-and-write: a stale second write is refused, a missing item is refused', async () => {
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-8'), { inline: true })
		await a.queue.recordArmor('sid-8', 'ARMOR-1', 'd1') // no stored armor yet: lands
		const stale = await a.queue.armorContext('sid-8') // reads ARMOR-1
		await a.queue.recordArmor('sid-8', 'ARMOR-2', 'd2') // the stored one is still the one read just before: lands
		await expect(stale!.record('ARMOR-3', 'd3')).rejects.toThrow('armor_changed') // read before ARMOR-2: refused
		expect(a.queue.armorOf('sid-8')).toBe('ARMOR-2')
		await expect(a.queue.recordArmor('nope', 'A', 'd')).rejects.toThrow('queue_item_missing')
		// two concurrent public writes: both read "stored armor = ARMOR-2"; the second finds it changed and is refused
		const both = await Promise.allSettled([a.queue.recordArmor('sid-8', 'ARMOR-4', 'd4'), a.queue.recordArmor('sid-8', 'ARMOR-5', 'd5')])
		expect(both.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
		expect(a.queue.armorOf('sid-8')).toBe('ARMOR-4')
		a.queue.dispose()
	})

	it('the per-sendId armor lock leaves no entry behind once nothing waits (slot and no-slot paths, failed writes included)', async () => {
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-9'), { inline: true })
		expect(a.queue.armorLockCount()).toBe(0)
		const c1 = (await a.queue.armorContext('sid-9'))!
		const c2 = (await a.queue.armorContext('sid-9'))!
		const writes = Promise.allSettled([c1.record('A1', 'd1'), c2.record('A2', 'd2')]) // the second is refused
		expect(a.queue.armorLockCount()).toBe(1) // held while queued
		const settled = await writes
		expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
		await new Promise((r) => setTimeout(r, 5))
		expect(a.queue.armorLockCount()).toBe(0)
		const b = page(disk) // no slot
		const n1 = (await b.queue.armorContext('sid-9'))!
		await n1.record('A9', 'd9').catch(() => undefined)
		await new Promise((r) => setTimeout(r, 5))
		expect(b.queue.armorLockCount()).toBe(0)
		a.queue.dispose(); b.queue.dispose()
	})

	it('the lock chain holds across three interleaved callers: c1 fails after 40 ms, c2 is then writing (60 ms) when c3 arrives: never two writes at once, c3 waits and is refused', async () => {
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-10'), { inline: true })
		const c1 = (await a.queue.armorContext('sid-10'))!
		const c2 = (await a.queue.armorContext('sid-10'))!
		const c3 = (await a.queue.armorContext('sid-10'))!
		Object.assign(putHook, { plan: [{ ms: 40, fail: true }, { ms: 60 }, { ms: 10 }], running: 0, max: 0, calls: 0 })
		const p1 = c1.record('C1', 'd1'); const p2 = c2.record('C2', 'd2')
		await new Promise((r) => setTimeout(r, 55)) // c1 has failed (40 ms), c2 is writing (until ~100 ms)
		expect(putHook.running).toBe(1)
		const p3 = c3.record('C3', 'd3')
		const settled = await Promise.allSettled([p1, p2, p3])
		putHook.plan = []
		expect(putHook.max).toBe(1) // never two writes of one sendId at the same time
		expect(putHook.calls).toBe(2) // c3 never wrote
		expect(settled.map((x) => x.status)).toEqual(['rejected', 'fulfilled', 'rejected'])
		expect(a.queue.armorOf('sid-10')).toBe('C2')
		a.queue.dispose()
	})

	it('a document that cannot be read (disk error, or not decodable) is NOT "no document": the attempt is held back, counted, and nothing is encrypted or sent', async () => {
		const endpoint = makeEndpoint(); install(endpoint)
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-6'), { inline: true })
		await a.queue.run('sid-6', () => a.deliver('sid-6'), { inline: true }) // one armor stored and posted
		a.queue.dispose()
		const postsBefore = endpoint.state.posts
		const b = page(disk)
		diskFault.readFails = true
		await expect(b.queue.armorContext('sid-6')).rejects.toThrow('idb_read_failed')
		expect((await b.deliver('sid-6')).kind).toBe('failed')
		diskFault.readFails = false
		disk.set([...disk.keys()][0], 'not-a-queue-document') // a record that does not decode
		await expect(b.queue.armorContext('sid-6')).rejects.toThrow('queue_item_unreadable')
		expect((await b.deliver('sid-6')).kind).toBe('failed')
		b.queue.dispose()
		expect(endpoint.state.posts).toBe(postsBefore) // not one request, not one new armor
		expect(endpoint.state.seen.size).toBe(1)
	})

	it('an attempt with no slot and no document has no armor context: nothing is stored, nothing is reused (a message that is not in the queue)', async () => {
		const disk: Disk = new Map()
		const a = page(disk)
		expect(await a.queue.armorContext('nope')).toBeUndefined()
		a.queue.dispose()
	})

	it('the recipient key changed: a new armor is made once, stored, and the later retries post that one', async () => {
		const endpoint = makeEndpoint(); install(endpoint)
		const disk: Disk = new Map()
		const a = page(disk)
		await a.queue.enqueue(item('sid-3'), { inline: true })
		await a.queue.run('sid-3', () => a.deliver('sid-3'), { inline: true })
		const firstKey = keyPublic
		keyPublic = (await generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ name: 'peer2' }] })).publicKey
		for (let i = 0; i < 3; i++) await a.deliver('sid-3')
		keyPublic = firstKey
		a.queue.dispose()
		expect(endpoint.state.seen.size).toBe(2) // the first armor, and ONE for the new key
	})
})
