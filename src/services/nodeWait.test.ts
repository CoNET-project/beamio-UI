/**
 * @jest-environment node
 */
// the wait of a shell send for the entry nodes (nodeWait.ts) and its interplay with the send queue's heartbeat, back-off and claim.
import { readFileSync } from 'fs'
import { join } from 'path'
import { createNodeWaiter } from './nodeWait'
import { base64JsonCodec } from './chatDraftStore'
import { createQueueStore, createSendQueue, type AttemptResult, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { resumeClassOf, resumeResultOf } from './sendResultMapping'

const tick = () => new Promise<void>((r) => setImmediate(r))
const flush = async () => { for (let i = 0; i < 8; i++) await tick() }

/** a virtual clock: setTimer / clearTimer / advance */
function clock() {
	let now = 1_000_000
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => { const h = { at: now + ms, fn, live: true }; timers.push(h); return h },
		clearTimer: (h: unknown) => { (h as { live: boolean }).live = false },
		advance: async (ms: number) => {
			const target = now + ms
			for (;;) {
				await flush()
				const due = timers.filter((x) => x.live && x.at <= target).sort((a, b) => a.at - b.at)[0]
				if (!due) break
				due.live = false
				now = Math.max(now, due.at)
				due.fn()
			}
			now = target
			await flush()
		},
	}
}

describe('createNodeWaiter', () => {
	function make() {
		const c = clock()
		const log: string[] = []
		let ready = false
		const waiter = createNodeWaiter({
			windowMs: 180_000, reaskMs: 5_000, setTimer: c.setTimer, clearTimer: c.clearTimer,
			nodesReady: () => ready, askStart: () => { log.push(`ask@${Math.round((c.now() - 1_000_000) / 1000)}`) },
			deliver: async (id) => { log.push(`deliver:${id}@${Math.round((c.now() - 1_000_000) / 1000)}`) },
			onExpire: (id) => { log.push(`expire:${id}@${Math.round((c.now() - 1_000_000) / 1000)}`) },
		})
		return { c, log, waiter, setReady: (v: boolean) => { ready = v } }
	}
	it('a wait asks the chat start at once and every 5 s while the nodes are missing, and ends with onExpire after 180 s', async () => {
		const { c, log, waiter } = make()
		waiter.wait('a', 'wire', 1)
		expect(log).toEqual(['ask@0'])
		await c.advance(12_000)
		expect(log).toEqual(['ask@0', 'ask@5', 'ask@10'])
		await c.advance(170_000)
		expect(log.filter((l) => l.startsWith('expire'))).toEqual(['expire:a@180'])
		const asks = log.filter((l) => l.startsWith('ask')).length
		await c.advance(60_000)
		expect(log.filter((l) => l.startsWith('ask')).length).toBe(asks) // nothing waits any more: no more asking
		expect(waiter.size()).toBe(0)
	})
	it('the nodes arriving deliver every waiting send at once, take the entries out first, and cancel the window', async () => {
		const { c, log, waiter, setReady } = make()
		waiter.wait('a', 'wa', 1)
		waiter.wait('b', 'wb', 2)
		await c.advance(30_000)
		setReady(true)
		waiter.nodesArrived()
		await flush()
		expect(log.filter((l) => l.startsWith('deliver'))).toEqual(['deliver:a@30', 'deliver:b@30'])
		expect(waiter.size()).toBe(0)
		await c.advance(400_000)
		expect(log.filter((l) => l.startsWith('expire'))).toEqual([]) // the windows were cancelled
		waiter.nodesArrived() // idempotent
		expect(log.filter((l) => l.startsWith('deliver')).length).toBe(2)
	})
	it('nudge (online / visible) asks the chat start now, only while something waits and the nodes are missing', async () => {
		const { c, log, waiter, setReady } = make()
		waiter.nudge()
		expect(log).toEqual([]) // nothing waits
		waiter.wait('a', 'w', 1)
		await c.advance(2_000)
		waiter.nudge()
		expect(log).toEqual(['ask@0', 'ask@2'])
		setReady(true)
		waiter.nudge()
		expect(log.length).toBe(2)
	})
	it('a second wait for the same id replaces the first window; dispose clears everything', async () => {
		const { c, log, waiter } = make()
		waiter.wait('a', 'w', 1)
		await c.advance(100_000)
		waiter.wait('a', 'w', 1) // the window starts again
		await c.advance(100_000)
		expect(log.filter((l) => l.startsWith('expire'))).toEqual([])
		waiter.dispose()
		await c.advance(500_000)
		expect(log.filter((l) => l.startsWith('expire'))).toEqual([])
		waiter.wait('b', 'w', 1)
		expect(waiter.size()).toBe(0)
	})
})

describe('the waiting send and the queue (heartbeat, back-off, claim): the page model of chat.tsx', () => {
	const EOA = '0xaaaa000000000000000000000000000000000001'
	const PEER = '0xcccc000000000000000000000000000000000003'
	function memoryDisk() {
		const docs = new Map<string, string>()
		const adapter: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
		return { docs, adapter }
	}
	/** the shell page after a cold start with the network back: no nodes yet; the message is stored as failed/interrupted and the queue item is on disk */
	function page(opts: { sendMs?: number } = {}) {
		const c = clock()
		const disk = memoryDisk()
		const world = { nodes: false, posts: [] as number[], status: 'failed' as string, sendError: 'interrupted' as string | undefined, asks: 0 }
		const item: QueueItem = { v: 1, sendId: 'w1', peer: PEER, text: 'hello', createdAt: 1, queuedAt: 1 }
		let queueRef: ReturnType<typeof createSendQueue> | null = null
		const gates: Array<() => void> = []
		const sendOnce = async (): Promise<AttemptResult> => {
			world.posts.push(c.now())
			world.status = 'sending'
			if (opts.sendMs) await new Promise<void>((resolve) => { gates.push(resolve) }) // a request that takes time
			world.status = 'sent'
			return { kind: 'sent', persisted: true }
		}
		// the attempt of chat.tsx (retry / first send): no nodes -> start the wait and report waiting; nodes -> send
		const attempt = async (): Promise<AttemptResult> => {
			world.status = 'sending'
			if (!world.nodes) { waiter.wait('m1', 'wire', c.now()); return { kind: 'waiting' } }
			return sendOnce()
		}
		const waiter = createNodeWaiter({
			windowMs: 180_000, reaskMs: 5_000, setTimer: c.setTimer, clearTimer: c.clearTimer,
			nodesReady: () => world.nodes, askStart: () => { world.asks += 1 },
			deliver: (_id) => (queueRef ? queueRef.run('w1', async () => sendOnce()) : sendOnce()),
			onExpire: () => { world.status = 'failed'; world.sendError = 'identity_not_ready'; void queueRef?.settle('w1', { kind: 'failed' }) },
		})
		const resume = async (): Promise<AttemptResult> => {
			const m = { status: world.status, sendError: world.sendError }
			const cls = resumeClassOf(m, { waitingForNodes: waiter.has('m1') })
			if (cls === 'trust_hold' || cls === 'live_node_wait') return resumeResultOf(cls)
			if (m.status === 'failed' || m.status === 'route_unconfirmed') return attempt()
			if (m.status === 'sending') return sendOnce() // chat.tsx: a `sending` message of this page load whose wait is over is sent again with the same sendId
			return { kind: 'held' }
		}
		const q = createSendQueue({ store: createQueueStore({ eoa: EOA, doc: disk.adapter, codec: base64JsonCodec() }), peer: PEER, resume, persistConfirmed: async () => true, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now, isVisible: () => true })
		queueRef = q
		return { c, disk, world, q, waiter, item, gates, resume }
	}

	it('S1-a: the native chat is ready (nodes arrive) at 100 s: the waiting message goes out at once (within 10 s), exactly one POST, the item is released', async () => {
		const p = page()
		await p.q.enqueue(p.item)
		p.q.kick('load')
		await p.c.advance(100_000)
		expect(p.world.posts).toEqual([])
		expect(p.q.stateOf('w1')).toBe('waiting')
		expect(p.world.asks).toBeGreaterThan(5) // the shell was asked again and again
		const readyAt = p.c.now()
		p.world.nodes = true
		p.waiter.nodesArrived()
		await p.c.advance(1_000)
		expect(p.world.posts.length).toBe(1)
		expect(p.world.posts[0] - readyAt).toBeLessThanOrEqual(10_000)
		expect(p.q.size()).toBe(0)
		expect(p.disk.docs.size).toBe(0)
	})

	it('after the 180 s window ended (settled failed) the heartbeat and the back-off still pick the item up: with the nodes there it is sent by the next tick, once', async () => {
		const p = page()
		await p.q.enqueue(p.item)
		p.q.kick('load')
		await p.c.advance(200_000) // the window ran out at 180 s
		expect(p.world.status === 'failed' || p.q.stateOf('w1') === 'waiting' || p.q.stateOf('w1') === 'failed').toBe(true)
		expect(p.world.posts).toEqual([])
		p.world.nodes = true // the nodes come after the window ended; the page's effect on allNodes calls nodesArrived (a wait may or may not be live: a tick may have started a new one)
		p.waiter.nodesArrived()
		await p.c.advance(70_000) // a delivery (if a wait was live) or the next heartbeat / back-off tick (if none was)
		expect(p.world.posts.length).toBe(1)
		expect(p.q.size()).toBe(0)
	})

	it('no double send: the nodes arrive in the same turn as a heartbeat tick; the delivery goes through the queue claim, so only one POST is made (a slow request included)', async () => {
		const p = page({ sendMs: 1 })
		await p.q.enqueue(p.item)
		p.q.kick('load')
		await p.c.advance(29_000) // waiting; the heartbeat is about to tick (30 s)
		p.world.nodes = true
		p.waiter.nodesArrived() // the direct delivery starts (claimed) and its request is in flight
		await p.c.advance(2_000) // the heartbeat tick comes while the request is in flight
		expect(p.world.posts.length).toBe(1)
		p.gates.forEach((g) => g())
		await p.c.advance(60_000)
		expect(p.world.posts.length).toBe(1)
		expect(p.q.size()).toBe(0)
	})

	it('a tick that finds the wait gone and the message still `sending` sends it (same sendId) instead of holding it', async () => {
		const p = page()
		await p.q.enqueue(p.item)
		p.q.kick('load')
		await p.c.advance(10_000)
		expect(p.q.stateOf('w1')).toBe('waiting')
		p.world.nodes = true
		// the wait entry is taken out by nodesArrived but the delivery is skipped (the claim was busy elsewhere): the item is still waiting, the message `sending`
		p.waiter.nodesArrived()
		await p.c.advance(35_000)
		expect(p.world.posts.length).toBeGreaterThanOrEqual(1)
		expect(p.q.size()).toBe(0)
	})
})

describe('wiring in chat.tsx', () => {
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('the page uses the waiter: delivery through the queue claim, expiry settles failed, the nodes arriving and online / visible call it, a `sending` message is sent again by the resume', () => {
		expect(chat).toMatch(/deliver: \(id, wire, t0\) => \{[\s\S]*?if \(sid && q\?\.has\(sid\)\) return q\.run\(sid, \(\) => deliverTextRef\.current\(id, wire, t0\)\)/)
		expect(chat).toMatch(/void sendQueueRef\.current\?\.settle\(sid, \{ kind: 'failed' \}\) \} \/\/ the wait is over/)
		expect(chat).toMatch(/if \(!allNodes\?\.length\) return[\s\S]{0,260}?nodeWaiterRef\.current\?\.nodesArrived\(\)/)
		expect(chat).toMatch(/const onOnline = \(\) => \{ nodeWaiterRef\.current\?\.nudge\(\); queue\.kick\('online'\) \}/)
		expect(chat).toMatch(/if \(document\.visibilityState === 'visible'\) \{ nodeWaiterRef\.current\?\.nudge\(\); queue\.kick\('visible'\) \}/)
		expect(chat).toMatch(/if \(m\.status === 'sending'\) \{\s*const wireOfSending = heldWireFromMessage\(m\)\s*if \(wireOfSending !== null\) return deliverText\(m\.id as string, wireOfSending, Date\.now\(\)\)/)
		expect(chat).not.toMatch(/nodeWaitSendsRef/)
	})
})
