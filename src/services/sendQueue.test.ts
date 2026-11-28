/**
 * @jest-environment node
 */
// the durable send queue (sendQueue.ts): storage per sendId, the state machine, the receipt rule, claims, the reload hold and the automatic resume.
import { base64JsonCodec, type DraftCodec } from './chatDraftStore'
import { createQueueStore, createSendQueue, queueDocId, queueDocPrefix, webLocksClaim, type AttemptResult, type QueueDocAdapter, type QueueItem, type SendQueue } from './sendQueue'
import { resumeClassOf, resumeResultOf, mapDeliverFailure } from './sendResultMapping'
import { chatWriteLockState, requestControlledReload, resetChatWriteLockForTest, setQueueDepth } from './chatWriteLock'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const flush = async () => { for (let i = 0; i < 6; i++) await tick() }

function memoryDisk() {
	const docs = new Map<string, string>()
	let failPut: ((id: string) => boolean) | null = null
	let failRemove: ((id: string) => boolean) | null = null
	const adapter: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: async (id, text) => {
			if (failPut?.(id)) throw new Error('persist_failed')
			docs.set(id, text)
		},
		remove: async (id) => {
			if (failRemove?.(id)) throw new Error('remove_failed')
			docs.delete(id)
		},
		list: async (prefix) => [...docs.keys()].filter((k) => k.startsWith(prefix)).sort(),
	}
	return { docs, adapter, failPut: (f: typeof failPut) => { failPut = f }, failRemove: (f: typeof failRemove) => { failRemove = f } }
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const OTHER = '0xbbbb000000000000000000000000000000000002'
const PEER = '0xcccc000000000000000000000000000000000003'
const mk = (sendId: string, text: string, peer = PEER, queuedAt = 1): QueueItem => ({ v: 1, sendId, peer, text, createdAt: queuedAt, queuedAt })

/** a manual timer queue so the retry timer is under the test's control */
function timers() {
	const list: Array<{ fn: () => void; ms: number; live: boolean }> = []
	return {
		list,
		setTimer: (fn: () => void, ms: number) => { const h = { fn, ms, live: true }; list.push(h); return h },
		clearTimer: (h: unknown) => { (h as { live: boolean }).live = false },
		fire: async () => { const h = list.find((x) => x.live); if (h) { h.live = false; h.fn() } await flush() },
		live: () => list.filter((x) => x.live).length,
		fireMs: async (ms: number) => { const h = list.find((x) => x.live && x.ms === ms); if (h) { h.live = false; h.fn() } await flush(); return !!h },
		liveMs: () => list.filter((x) => x.live).map((x) => x.ms),
	}
}

function rig(opts: {
	disk?: ReturnType<typeof memoryDisk>
	codec?: DraftCodec
	eoa?: string
	peer?: string
	resume?: (item: QueueItem) => Promise<AttemptResult>
	persistConfirmed?: (item: QueueItem) => Promise<boolean>
	claim?: (sendId: string) => Promise<null | (() => void)>
	online?: () => boolean
	depthKey?: string
	heartbeatMs?: number
	visible?: () => boolean
	confirmedRetryMs?: number
	retryDelaysMs?: number[]
	now?: () => number
}) {
	const disk = opts.disk ?? memoryDisk()
	const t = timers()
	const eoa = opts.eoa ?? EOA
	const store = createQueueStore({ eoa, doc: disk.adapter, codec: opts.codec ?? base64JsonCodec() })
	const attempts: string[] = []
	const q = createSendQueue({
		store,
		peer: opts.peer ?? PEER,
		resume: opts.resume ?? (async (item) => { attempts.push(item.sendId); return { kind: 'sent', persisted: true } }),
		persistConfirmed: opts.persistConfirmed ?? (async () => true),
		claim: opts.claim,
		isOnline: opts.online,
		setTimer: t.setTimer,
		clearTimer: t.clearTimer,
		onDepth: (n) => setQueueDepth(opts.depthKey ?? `${eoa}:${opts.peer ?? PEER}`, n),
		heartbeatMs: opts.heartbeatMs ?? 0, // off unless a test is about the heartbeat
		isVisible: opts.visible,
		confirmedRetryMs: opts.confirmedRetryMs,
		retryDelaysMs: opts.retryDelaysMs,
		now: opts.now,
	})
	return { disk, store, q, t, attempts }
}

beforeEach(() => resetChatWriteLockForTest())

describe('storage: one document per sendId, keyed by the account', () => {
	it('the key is chat-queue-v1:<eoa lower>:<sendId>; two messages to the same contact are two documents; an upsert of one never touches the other', async () => {
		const r = rig({})
		await r.q.enqueue(mk('s1', 'first'))
		await r.q.enqueue(mk('s2', 'second'))
		expect([...r.disk.docs.keys()].sort()).toEqual([queueDocId(EOA, 's1'), queueDocId(EOA, 's2')])
		expect(queueDocId(EOA.toUpperCase().replace('0X', '0x'), 's1')).toBe(`chat-queue-v1:${EOA}:s1`)
		const before = r.disk.docs.get(queueDocId(EOA, 's2'))
		await r.store.put(mk('s1', 'first, changed'))
		expect(r.disk.docs.get(queueDocId(EOA, 's2'))).toBe(before)
		expect((await r.store.list()).map((i) => i.text).sort()).toEqual(['first, changed', 'second'])
	})

	it('another account never reads this account\'s queue (account switch, logout, lock and reopen)', async () => {
		const disk = memoryDisk()
		const a = rig({ disk, eoa: EOA })
		await a.q.enqueue(mk('s1', 'secret of A'))
		const b = rig({ disk, eoa: OTHER })
		expect(await b.store.list()).toEqual([])
		expect(await b.store.get('s1')).toBeNull()
		expect((await b.q.load())).toEqual([])
		expect(queueDocPrefix(OTHER)).not.toBe(queueDocPrefix(EOA))
		// the same account again sees it
		expect((await rig({ disk, eoa: EOA }).store.list()).map((i) => i.text)).toEqual(['secret of A'])
	})

	it('the content goes through the codec (sealed in the browser) and a document that cannot be read is not an item', async () => {
		const disk = memoryDisk()
		const sealed: DraftCodec = { kind: 'aes-gcm', encode: async (p) => `S.${Buffer.from(p).reverse().toString('base64')}`, decode: async (t) => (t.startsWith('S.') ? Buffer.from(t.slice(2), 'base64').reverse().toString() : null) }
		const a = rig({ disk, codec: sealed })
		await a.q.enqueue(mk('s1', 'needle-text'))
		expect([...disk.docs.values()][0]).not.toContain('needle-text')
		const wrong = rig({ disk, codec: { kind: 'aes-gcm', encode: async (p) => p, decode: async () => null } })
		expect(await wrong.store.list()).toEqual([])
	})

	it('loads only the items of its conversation', async () => {
		const disk = memoryDisk()
		const a = rig({ disk })
		await a.q.enqueue(mk('s1', 'to peer'))
		await a.store.put(mk('s9', 'to another peer', '0xdddd000000000000000000000000000000000004'))
		const again = rig({ disk })
		expect((await again.q.load()).map((i) => i.sendId)).toEqual(['s1'])
		expect(again.q.size()).toBe(1)
	})
})

describe('the receipt rule and the state machine', () => {
	it('an item is removed only when the receipt was seen AND the sent state is on disk', async () => {
		const r = rig({ resume: async () => ({ kind: 'sent', persisted: true }) })
		await r.q.enqueue(mk('s1', 'x'))
		await r.q.run('s1', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		expect(r.q.has('s1')).toBe(false)
		expect(r.disk.docs.size).toBe(0)
	})

	it('a receipt without the sent state on disk keeps the item (confirmed); it is NOT sent again, only the persistence is retried', async () => {
		let deliveries = 0
		let persistCalls = 0
		const r = rig({ persistConfirmed: async () => { persistCalls += 1; return persistCalls >= 2 } })
		await r.q.enqueue(mk('s1', 'x'))
		await r.q.run('s1', async () => { deliveries += 1; return { kind: 'sent', persisted: false } }, { inline: true })
		expect(r.q.snapshot()[0].state).toBe('confirmed')
		expect(r.disk.docs.size).toBe(1)
		r.q.kick('timer')
		await flush()
		expect(persistCalls).toBe(1)
		expect(r.q.has('s1')).toBe(true) // the second write failed again
		r.q.kick('timer')
		await flush()
		expect(persistCalls).toBe(2)
		expect(r.q.has('s1')).toBe(false)
		expect(deliveries).toBe(1) // one request in all
	})

	it('failure, timeout (throw) and unknown receipts leave the item in the queue; the retry keeps the sendId', async () => {
		const results: Array<AttemptResult | 'throw'> = [{ kind: 'failed' }, 'throw', { kind: 'sent', persisted: true }]
		const seen: string[] = []
		const r = rig({
			resume: async (item) => {
				seen.push(item.sendId)
				const x = results.shift()
				if (x === 'throw') throw new Error('socket closed')
				return x as AttemptResult
			},
		})
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		await flush()
		expect(r.q.snapshot()[0].state).toBe('failed')
		await r.t.fire()
		expect(r.q.snapshot()[0].state).toBe('unknown')
		await r.t.fire()
		expect(r.q.has('s1')).toBe(false)
		expect(seen).toEqual(['s1', 's1', 's1'])
	})

	it('a lost receipt is resolved by the same sendId again, not by a blind send: every attempt carries the one sendId and the receiver shows it once', async () => {
		const received = new Map<string, number>()
		let lostReceipt = true
		const r = rig({
			resume: async (item) => {
				received.set(item.sendId, (received.get(item.sendId) ?? 0) + 1) // the request arrived
				if (lostReceipt) { lostReceipt = false; return { kind: 'unknown' } } // ... but the receipt never came back
				return { kind: 'sent', persisted: true }
			},
		})
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		await flush()
		await r.t.fire()
		expect(received.get('s1')).toBe(2) // two requests, one sendId
		expect([...received.keys()]).toEqual(['s1']) // the receiver de-duplicates by it: one message
		expect(r.q.has('s1')).toBe(false)
	})

	it('held is never retried automatically (the user verifies the key first); settle after the user acts removes it', async () => {
		let calls = 0
		const r = rig({ resume: async () => { calls += 1; return { kind: 'held' } } })
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		await flush()
		r.q.kick('online')
		r.q.kick('visible')
		await flush()
		expect(calls).toBe(1)
		expect(r.t.live()).toBe(0)
		await r.q.settle('s1', { kind: 'sent', persisted: true })
		expect(r.q.has('s1')).toBe(false)
	})

	it('a late or duplicate acknowledgement does nothing (idempotent settle)', async () => {
		const r = rig({})
		await r.q.enqueue(mk('s1', 'x'))
		await r.q.run('s1', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		await r.q.settle('s1', { kind: 'sent', persisted: true })
		await r.q.settle('s1', { kind: 'failed' })
		expect(r.q.size()).toBe(0)
		expect(chatWriteLockState().queued).toBe(0)
	})

	it('a failed removal keeps the item in memory as confirmed (the sent state is on disk); the next pass removes it without sending', async () => {
		let failing = true
		let sends = 0
		const disk = memoryDisk()
		disk.failRemove(() => failing)
		const r = rig({ disk })
		await r.q.enqueue(mk('s1', 'x'))
		await r.q.run('s1', async () => { sends += 1; return { kind: 'sent', persisted: true } }, { inline: true })
		expect(r.q.snapshot()[0].state).toBe('confirmed')
		failing = false
		r.q.kick('timer')
		await flush()
		expect(r.q.has('s1')).toBe(false)
		expect(sends).toBe(1)
	})

	it('a failed write of the item itself: not enqueued, nothing to send, the hold is released', async () => {
		const disk = memoryDisk()
		disk.failPut(() => true)
		const r = rig({ disk })
		const res = await r.q.enqueue(mk('s1', 'x'))
		expect(res.ok).toBe(false)
		expect(r.q.size()).toBe(0)
		expect(chatWriteLockState().queued).toBe(0)
	})
})

describe('same conversation, two messages, receipts out of order', () => {
	it('the second message is acknowledged first: the first stays in the queue (also after a restart), the reload stays held, and the last acknowledgement releases it exactly once', async () => {
		const disk = memoryDisk()
		const r = rig({ disk })
		await r.q.enqueue(mk('s1', 'first'), { inline: true })
		await r.q.enqueue(mk('s2', 'second'), { inline: true })
		let reloads = 0
		expect(requestControlledReload(() => { reloads += 1 })).toBe(true)
		let release1: (v: AttemptResult) => void = () => undefined
		const p1 = r.q.run('s1', () => new Promise<AttemptResult>((res) => { release1 = res }), { inline: true })
		const p2 = r.q.run('s2', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		await p2
		expect(r.q.has('s2')).toBe(false)
		expect(r.q.has('s1')).toBe(true)
		expect(reloads).toBe(0) // one confirmed is not enough
		expect(chatWriteLockState()).toMatchObject({ queued: 1, heldReload: true })
		// a restart now: the first message is still on disk and comes back
		const again = rig({ disk })
		expect((await again.q.load()).map((i) => i.sendId)).toEqual(['s1'])
		again.q.dispose()
		release1({ kind: 'sent', persisted: true })
		await p1
		expect(r.q.size()).toBe(0)
		expect(reloads).toBe(1) // released once, after the last item
		expect(chatWriteLockState()).toMatchObject({ queued: 0, heldReload: false })
	})

	it('a message queued while the hold is waiting for the queue to empty keeps the reload held (no reload right after a new message)', async () => {
		const r = rig({})
		await r.q.enqueue(mk('s1', 'first'), { inline: true })
		let reloads = 0
		requestControlledReload(() => { reloads += 1 })
		const p1 = r.q.run('s1', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		// a new message is queued in the same turn as the first one settles
		const e2 = r.q.enqueue(mk('s2', 'second'), { inline: true })
		await p1
		await e2
		expect(reloads).toBe(0)
		expect(chatWriteLockState().queued).toBe(1)
		await r.q.run('s2', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		expect(reloads).toBe(1)
	})

	it('the queue holds the reload from the enqueue call on, before the write has landed', async () => {
		const r = rig({})
		const e = r.q.enqueue(mk('s1', 'x'))
		expect(chatWriteLockState().queued).toBe(1)
		await e
	})
})

describe('automatic resume: triggers, offline, restart, one attempt at a time', () => {
	it('queued offline, reopened, back online: it goes out by itself, with the original sendId, and no Retry is needed', async () => {
		const disk = memoryDisk()
		const offlineRig = rig({ disk, online: () => false })
		await offlineRig.q.enqueue(mk('s1', 'written offline'))
		offlineRig.q.kick('load')
		await flush()
		expect(offlineRig.attempts).toEqual([]) // offline: nothing is tried
		offlineRig.q.dispose()
		// the device is off and on again: a new page, a new queue on the same disk
		let online = false
		const sent: string[] = []
		const again = rig({ disk, online: () => online, resume: async (item) => { sent.push(item.sendId); return { kind: 'sent', persisted: true } } })
		expect((await again.q.load()).map((i) => i.text)).toEqual(['written offline'])
		again.q.kick('load')
		await flush()
		expect(sent).toEqual([]) // still offline
		online = true
		again.q.kick('online')
		await flush()
		expect(sent).toEqual(['s1'])
		expect(disk.docs.size).toBe(0)
	})

	it('online and load at the same moment: one attempt per sendId (single flight)', async () => {
		let release: (v: AttemptResult) => void = () => undefined
		let calls = 0
		const r = rig({ resume: () => { calls += 1; return new Promise<AttemptResult>((res) => { release = res }) } })
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		r.q.kick('online')
		r.q.kick('visible')
		await flush()
		expect(calls).toBe(1)
		release({ kind: 'sent', persisted: true })
		await flush()
		expect(r.q.size()).toBe(0)
	})

	it('two tabs on the same account: a claim per sendId lets one send; the other skips, and finds the item removed afterwards', async () => {
		const disk = memoryDisk()
		const held = new Set<string>()
		const claim = async (id: string) => { if (held.has(id)) return null; held.add(id); return () => { held.delete(id) } }
		const sends: string[] = []
		let release: (v: AttemptResult) => void = () => undefined
		const tabA = rig({ disk, claim, resume: (item) => { sends.push('A:' + item.sendId); return new Promise<AttemptResult>((res) => { release = res }) } })
		const tabB = rig({ disk, claim, resume: async (item) => { sends.push('B:' + item.sendId); return { kind: 'sent', persisted: true } } })
		await tabA.q.enqueue(mk('s1', 'x'))
		await tabA.q.load()
		await tabB.q.load()
		tabA.q.kick('load')
		await flush()
		tabB.q.kick('load') // A holds the claim: B skips
		await flush()
		expect(sends).toEqual(['A:s1'])
		release({ kind: 'sent', persisted: true })
		await flush()
		expect(disk.docs.size).toBe(0)
		tabB.q.kick('timer') // the claim is free now, but the document is gone: B reads it again and skips
		await flush()
		expect(sends).toEqual(['A:s1']) // one send in all
		expect(tabB.q.has('s1')).toBe(false)
	})

	it('without Web Locks (a shell page) the claim is always granted; with the browser API one tab holds it', async () => {
		const grant = await webLocksClaim(EOA)('s1')
		expect(typeof grant).toBe('function')
		const held = new Set<string>()
		;(globalThis as unknown as { navigator: unknown }).navigator = {
			locks: {
				request: (name: string, _o: unknown, cb: (lock: unknown) => unknown) => {
					if (held.has(name)) return Promise.resolve(cb(null))
					held.add(name)
					return Promise.resolve(cb({ name })).finally(() => held.delete(name))
				},
			},
		}
		const first = await webLocksClaim(EOA)('s1')
		const second = await webLocksClaim(EOA)('s1')
		expect(typeof first).toBe('function')
		expect(second).toBeNull()
		;(first as () => void)()
		await flush()
		const third = await webLocksClaim(EOA)('s1')
		expect(typeof third).toBe('function')
		;(third as () => void)()
		delete (globalThis as unknown as { navigator?: unknown }).navigator
	})

	it('a draft is never sent by the queue: only queue items are attempted', async () => {
		const disk = memoryDisk()
		disk.docs.set(`chat-draft-v1:${EOA}`, 'a draft that was typed') // the draft document is in the same database
		const r = rig({ disk })
		await r.q.load()
		r.q.kick('load')
		await flush()
		expect(r.attempts).toEqual([])
		expect(r.q.size()).toBe(0)
	})

	it('the retry timer backs off and stops after its steps; a new trigger starts it again', async () => {
		const r = rig({ resume: async () => ({ kind: 'failed' }) })
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		await flush()
		const delays: number[] = []
		for (let i = 0; i < 10; i++) {
			const h = r.t.list.find((x) => x.live)
			if (!h) break
			delays.push(h.ms)
			await r.t.fire()
		}
		expect(delays).toEqual([3000, 10000, 30000, 60000, 60000, 60000])
		expect(r.t.live()).toBe(0)
		r.q.kick('online')
		await flush()
		expect(r.t.live()).toBe(1) // started again by the trigger
	})

	it('at most three attempts run at the same time', async () => {
		let running = 0
		let peak = 0
		const releases: Array<() => void> = []
		const r = rig({
			resume: () => new Promise<AttemptResult>((res) => {
				running += 1
				peak = Math.max(peak, running)
				releases.push(() => { running -= 1; res({ kind: 'sent', persisted: true }) })
			}),
		})
		for (let i = 0; i < 6; i++) await r.q.enqueue(mk(`s${i}`, `m${i}`, PEER, i))
		r.q.kick('load')
		await flush()
		expect(peak).toBe(3)
		while (releases.length) { releases.shift()!(); await flush() }
		await flush()
		expect(r.q.size()).toBe(0)
	})

	it('dispose clears the timer and the hold (account switch / leaving the conversation)', async () => {
		const r = rig({ resume: async () => ({ kind: 'failed' }) })
		await r.q.enqueue(mk('s1', 'x'))
		r.q.kick('load')
		await flush()
		expect(r.t.live()).toBe(1)
		r.q.dispose()
		expect(r.t.live()).toBe(0)
		expect(chatWriteLockState().queued).toBe(0)
	})
})

describe('inline first attempt', () => {
	it('an inline enqueue is inflight at once: an automatic kick does not start a second attempt for it', async () => {
		const r = rig({})
		await r.q.enqueue(mk('s1', 'x'), { inline: true })
		r.q.kick('online')
		await flush()
		expect(r.attempts).toEqual([])
		expect(r.q.snapshot()[0].state).toBe('inflight')
		let seen: SendQueue | null = r.q
		void seen
		seen = null
	})
})

describe('a kill while the shell waits for the entry nodes', () => {
	// the production resume (chat.tsx resumeSendRef) as a function of the stored message and of the page's own node wait
	const resumeLike = (stored: Map<string, { status: string; sendError?: string }>, waiting: Set<string>, calls: string[], outcome: () => AttemptResult) => async (item: QueueItem): Promise<AttemptResult> => {
		calls.push(item.sendId)
		const m = stored.get(item.sendId)!
		const c = resumeClassOf(m, { waitingForNodes: waiting.has(item.sendId) })
		if (c === 'trust_hold' || c === 'live_node_wait') return resumeResultOf(c)
		return outcome()
	}

	it('page 1 waits for the nodes (held, in memory only); after the kill page 2 has no wait: the stored message is resumed, a failure backs off and retries, and it goes out when the nodes are there', async () => {
		const disk = memoryDisk()
		const stored = new Map([['w1', { status: 'failed', sendError: 'interrupted' }]])
		const waiting1 = new Set(['w1'])
		const calls1: string[] = []
		const p1 = rig({ disk, resume: resumeLike(stored, waiting1, calls1, () => ({ kind: 'sent', persisted: true })) })
		await p1.q.enqueue(mk('w1', 'waits for nodes'))
		p1.q.kick('load')
		await flush()
		expect(p1.q.stateOf('w1')).toBe('waiting') // the wait owns it (a wait is not a hold: the queue ticks it); the state is NOT written to the document
		p1.q.dispose() // the kill: the timer of the wait is gone with the page
		let nodes = false
		const calls2: string[] = []
		const p2 = rig({ disk, resume: resumeLike(stored, new Set(), calls2, () => (nodes ? { kind: 'sent', persisted: true } : mapDeliverFailure('identity_not_ready'))) })
		expect((await p2.q.load()).map((i) => i.sendId)).toEqual(['w1'])
		expect(p2.q.stateOf('w1')).toBe('queued') // not held: the held state of page 1 did not survive
		p2.q.kick('load')
		await flush()
		expect(calls2).toEqual(['w1'])
		expect(p2.q.stateOf('w1')).toBe('failed') // no nodes yet: a retryable failure, not a hold
		await p2.t.fire() // back-off
		expect(calls2).toEqual(['w1', 'w1'])
		nodes = true
		await p2.t.fire()
		expect(calls2.length).toBe(3)
		expect(disk.docs.size).toBe(0) // sent, persisted, released
	})

	it('trust holds are not touched by the same restart: they stay held, are never attempted, and the document stays for the user', async () => {
		const disk = memoryDisk()
		const stored = new Map([['t1', { status: 'fingerprint_changed' }], ['t2', { status: 'first_fetch_pending' }], ['t3', { status: 'failed', sendError: 'fingerprint_changed' }]])
		const calls: string[] = []
		const again = rig({ disk, resume: resumeLike(stored, new Set(), calls, () => ({ kind: 'sent', persisted: true })) })
		for (const id of ['t1', 't2', 't3']) await again.q.enqueue(mk(id, id))
		again.q.kick('load')
		await flush()
		for (const id of ['t1', 't2', 't3']) expect(again.q.stateOf(id)).toBe('held')
		again.q.kick('online')
		await again.t.fire()
		await flush()
		expect(calls.sort()).toEqual(['t1', 't2', 't3']) // each looked at once on the load; none re-attempted by online or the timer
		expect(disk.docs.size).toBe(3)
	})

	it('resumeClassOf: only a trust hold or a wait this page started is not retried; every stored state of an interrupted send is', () => {
		for (const st of ['sending', 'failed', 'route_unconfirmed', 'sent']) expect(resumeClassOf({ status: st }, { waitingForNodes: false })).toBe('retry')
		expect(resumeClassOf({ status: 'failed', sendError: 'identity_not_ready' }, { waitingForNodes: false })).toBe('retry')
		expect(resumeClassOf({ status: 'failed', sendError: 'interrupted' }, { waitingForNodes: false })).toBe('retry')
		expect(resumeClassOf({ status: 'failed' }, { waitingForNodes: true })).toBe('live_node_wait')
		expect(resumeClassOf({ status: 'fingerprint_changed' }, { waitingForNodes: true })).toBe('trust_hold')
		expect(resumeClassOf({ status: 'first_fetch_pending' }, { waitingForNodes: false })).toBe('trust_hold')
	})

	it('the held-retry path (the Retry / Send anyway tap) settles route_unconfirmed as failed (retryable), a trust hold as held', () => {
		expect(mapDeliverFailure('route_unconfirmed')).toEqual({ kind: 'failed' })
		expect(mapDeliverFailure('fingerprint_changed')).toEqual({ kind: 'held' })
		expect(mapDeliverFailure('first_fetch_pending')).toEqual({ kind: 'held' })
	})
})

describe('the steady heartbeat', () => {
	const failing = (calls: string[], okAfter: () => boolean) => async (item: QueueItem): Promise<AttemptResult> => {
		calls.push(item.sendId)
		return okAfter() ? { kind: 'sent', persisted: true } : { kind: 'failed' }
	}

	it('a retry timer that fires while the page believes it is offline neither stops nor ends the chain; when the network is back and no event arrives, the item still goes out', async () => {
		const calls: string[] = []
		let online = true
		let ok = false
		const r = rig({ online: () => online, resume: failing(calls, () => ok) })
		await r.q.enqueue(mk('p1', 'probe'))
		r.q.kick('load')
		await flush()
		expect(calls).toEqual(['p1']) // first attempt fails, the 3 s timer is set
		online = false // the page thinks it is offline (a shell WebView after a kill)
		await r.t.fire() // timer: the attempt is made anyway and the chain goes on
		expect(calls.length).toBe(2)
		expect(r.t.live()).toBeGreaterThan(0)
		online = true // the network is back, and NO online / visible / load event reaches the page
		ok = true
		for (let i = 0; i < 3 && r.q.size() > 0; i++) await r.t.fire()
		expect(r.q.size()).toBe(0)
		expect(r.disk.docs.size).toBe(0)
	})

	it('after the six back-off steps are used up the heartbeat keeps trying, every 30 s, without any event and without asking navigator.onLine', async () => {
		const calls: string[] = []
		let ok = false
		const r = rig({ heartbeatMs: 30_000, online: () => false, resume: failing(calls, () => ok), retryDelaysMs: [3000, 10000] })
		await r.q.enqueue(mk('h1', 'heartbeat'))
		expect(r.t.liveMs()).toContain(30_000) // armed by the enqueue
		r.q.kick('load') // offline and an event: nothing is tried
		await flush()
		expect(calls).toEqual([])
		await r.t.fireMs(30_000) // the heartbeat does not ask online()
		expect(calls).toEqual(['h1'])
		for (let i = 0; i < 4; i++) await r.t.fire() // the back-off steps run out
		const afterBackoff = calls.length
		expect(r.t.liveMs().filter((m) => m !== 30_000)).toEqual([]) // no retry timer is left
		ok = true
		await r.t.fireMs(30_000)
		expect(calls.length).toBe(afterBackoff + 1)
		expect(r.q.size()).toBe(0)
		expect(r.disk.docs.size).toBe(0)
		expect(r.t.liveMs()).toEqual([]) // nothing is waiting: the heartbeat stops by itself
	})

	it('a hidden page is not ticked; the next tick after it is visible again is', async () => {
		const calls: string[] = []
		let vis = false
		const r = rig({ heartbeatMs: 30_000, visible: () => vis, resume: failing(calls, () => false) })
		await r.q.enqueue(mk('v1', 'hidden'))
		await r.t.fireMs(30_000)
		expect(calls).toEqual([])
		expect(r.t.liveMs()).toContain(30_000) // the chain goes on
		vis = true
		await r.t.fireMs(30_000)
		expect(calls).toEqual(['v1'])
	})

	it('a trust hold is not ticked by the heartbeat and does not keep it alive', async () => {
		const calls: string[] = []
		const r = rig({ heartbeatMs: 30_000, resume: async (i) => { calls.push(i.sendId); return { kind: 'held' } } })
		await r.q.enqueue(mk('t1', 'trust hold'))
		r.q.kick('load')
		await flush()
		expect(r.q.stateOf('t1')).toBe('held')
		await r.t.fireMs(30_000)
		expect(calls).toEqual(['t1']) // only the load attempt
		expect(r.t.liveMs()).toEqual([])
	})

	it('a confirmed item (the receipt was seen, the copy is not durable) is ticked at the slow pace only, never re-sent, and never released without durability', async () => {
		let t = 1_000_000
		const confirmedRuns: string[] = []
		let durable = false
		const r = rig({
			heartbeatMs: 30_000, confirmedRetryMs: 180_000, now: () => t,
			resume: async () => ({ kind: 'sent', persisted: false }),
			persistConfirmed: async (item) => { confirmedRuns.push(item.sendId); return durable },
		})
		await r.q.enqueue(mk('c1', 'confirmed'))
		r.q.kick('load')
		await flush()
		expect(r.q.stateOf('c1')).toBe('confirmed')
		for (let i = 0; i < 5; i++) { t += 30_000; await r.t.fireMs(30_000) } // 150 s of heartbeats
		expect(confirmedRuns).toEqual([]) // 150 s of ticks: the slow pace (180 s) has not come, nothing was tried
		const early = confirmedRuns.length
		t += 40_000 // 190 s since the last attempt
		await r.t.fireMs(30_000)
		expect(confirmedRuns.length).toBe(early + 1)
		t += 30_000 // the next tick: the retry just made moved the clock, so no second one
		await r.t.fireMs(30_000)
		expect(confirmedRuns.length).toBe(early + 1)
		t += 160_000 // 190 s after that retry
		await r.t.fireMs(30_000)
		expect(confirmedRuns.length).toBe(early + 2)
		expect(r.q.size()).toBe(1)
		durable = true
		t += 200_000
		await r.t.fireMs(30_000)
		expect(r.q.size()).toBe(0)
		expect(r.disk.docs.size).toBe(0)
	})

	it('dispose clears the heartbeat; the kick log keeps the source of every kick and what the page believed (QA export)', async () => {
		const r = rig({ heartbeatMs: 30_000, online: () => false, resume: failing([], () => false) })
		await r.q.enqueue(mk('k1', 'log'))
		r.q.kick('load')
		r.q.kick('online')
		await r.t.fireMs(30_000)
		expect(r.q.kickLog().map((k) => `${k.trigger}:${k.online}:${k.started}`)).toEqual(['load:false:0', 'online:false:0', 'heartbeat:false:1'])
		r.q.dispose()
		expect(r.t.liveMs()).toEqual([])
	})
})

describe('the state `waiting` (the page waits for the entry nodes) is ticked, never stranded', () => {
	it('the heartbeat and the back-off tick a waiting item; while the page\'s own wait is live every tick only reports waiting (no request); when the wait is gone the same tick retries', async () => {
		const disk = memoryDisk()
		const stored = new Map([['n1', { status: 'sending' as string, sendError: undefined as string | undefined }]])
		const waiting = new Set(['n1'])
		const calls: string[] = []
		const r = rig({ disk, heartbeatMs: 30_000, resume: async (item) => {
			calls.push(item.sendId)
			const c = resumeClassOf(stored.get(item.sendId)!, { waitingForNodes: waiting.has(item.sendId) })
			if (c === 'trust_hold' || c === 'live_node_wait') return resumeResultOf(c)
			return { kind: 'sent', persisted: true } // the retry goes out
		} })
		await r.q.enqueue(mk('n1', 'waits'))
		r.q.kick('load')
		await flush()
		expect(r.q.stateOf('n1')).toBe('waiting')
		expect(r.t.liveMs()).toContain(30_000) // the heartbeat runs for a waiting item
		await r.t.fire() // the back-off tick
		await r.t.fireMs(30_000) // the heartbeat tick
		expect(r.q.stateOf('n1')).toBe('waiting') // still the page's own live wait: nothing was sent
		expect(calls.length).toBeGreaterThanOrEqual(3)
		waiting.delete('n1') // the wait is over (the page lost it)
		stored.set('n1', { status: 'failed', sendError: 'identity_not_ready' })
		await r.t.fireMs(30_000)
		expect(r.q.size()).toBe(0)
		expect(disk.docs.size).toBe(0)
	})
	it('a waiting item keeps the reload held like any item that is not awaiting (firm), and a trust hold is still not ticked', async () => {
		const holds: Array<{ firm: number; awaiting: number }> = []
		const r = rig({ heartbeatMs: 30_000, resume: async () => ({ kind: 'waiting' }) })
		const q2 = createSendQueue({ store: r.store, peer: PEER, resume: async () => ({ kind: 'waiting' }), persistConfirmed: async () => true, onHold: (h) => holds.push(h), heartbeatMs: 0 })
		await q2.enqueue(mk('n2', 'x'))
		await q2.run('n2', async () => ({ kind: 'waiting' }))
		expect(holds[holds.length - 1]).toMatchObject({ firm: 1, awaiting: 0 })
		q2.dispose()
	})

	it('a waiting result arms the back-off timer (the tick that finds the wait gone retries it) even without the heartbeat', async () => {
		const r = rig({ heartbeatMs: 0, resume: async () => ({ kind: 'waiting' }) })
		await r.q.enqueue(mk('n3', 'x'))
		r.q.kick('load')
		await flush()
		expect(r.q.stateOf('n3')).toBe('waiting')
		expect(r.t.liveMs()).toContain(3000)
	})
})


describe('an awaiting item is asked again at a slowing pace (30 s, 1, 2, 5, 10 minutes, capped), never released by it', () => {
	it('the steps and the cap', async () => {
		const q = await import('./sendQueue')
		expect(q.AWAITING_RETRY_STEPS_MS).toEqual([30_000, 60_000, 120_000, 300_000, 600_000])
		expect([0, 1, 2, 3, 4, 5, 50].map((n) => q.awaitingRetryDelayMs(n))).toEqual([30_000, 60_000, 120_000, 300_000, 600_000, 600_000, 600_000])
		expect(q.awaitingRetryDelayMs(-3)).toBe(30_000)
	})

	it('the heartbeat re-POSTs an awaiting item after 30 s, 1, 2, 5 and then every 10 minutes: the gaps grow and stop at 10 minutes', async () => {
		let t = 5_000_000
		const attemptsAt: number[] = []
		const r = rig({ heartbeatMs: 30_000, now: () => t, retryDelaysMs: [], resume: async () => { attemptsAt.push(t); return { kind: 'awaiting', persisted: true } } })
		await r.q.enqueue(mk('aw1', 'no proof'))
		r.q.kick('load')
		await flush()
		const t0 = attemptsAt[0]
		for (let i = 0; i < 400; i++) { t += 30_000; await r.t.fireMs(30_000) } // 200 minutes of heartbeats
		const gaps = attemptsAt.slice(1).map((x, i) => x - attemptsAt[i])
		expect(gaps.slice(0, 6)).toEqual([30_000, 60_000, 120_000, 300_000, 600_000, 600_000])
		expect(Math.max(...gaps)).toBe(600_000)
		expect(attemptsAt.length).toBeLessThan(2 + 4 + 200 / 10 + 2) // about 24 attempts in 200 minutes, not 400
		expect(t0).toBe(5_000_000)
		expect(r.q.stateOf('aw1')).toBe('awaiting') // slowing down never releases the item
		expect(r.disk.docs.size).toBe(1)
	})

	it('an event (reopen, online, visible) still tries at once; a restart begins the pace again; confirmed keeps its own 3 minutes', async () => {
		let t = 9_000_000
		const calls: string[] = []
		const make = () => rig({ heartbeatMs: 30_000, now: () => t, retryDelaysMs: [], resume: async (i) => { calls.push(i.sendId); return { kind: 'awaiting', persisted: true } } })
		const a = make()
		await a.q.enqueue(mk('aw2', 'x'))
		a.q.kick('load')
		await flush()
		for (let i = 0; i < 6; i++) { t += 30_000; await a.t.fireMs(30_000) }
		const before = calls.length
		a.q.kick('online') // an event
		await flush()
		expect(calls.length).toBe(before + 1)
		a.q.dispose()
		const b = rig({ disk: a.disk, heartbeatMs: 30_000, now: () => t, retryDelaysMs: [], resume: async (i) => { calls.push(i.sendId); return { kind: 'awaiting', persisted: true } } })
		await b.q.load()
		b.q.kick('load')
		await flush()
		const afterRestart = calls.length
		t += 30_000
		await b.t.fireMs(30_000) // 30 s after the restart: the first step again
		expect(calls.length).toBe(afterRestart + 1)
		b.q.dispose()
	})

	it('the back-off timer does not hammer an awaiting item either (it waits for the same pace)', async () => {
		let t = 1_000_000
		const calls: number[] = []
		const r = rig({ heartbeatMs: 0, now: () => t, resume: async () => { calls.push(t); return { kind: 'awaiting', persisted: true } } })
		await r.q.enqueue(mk('aw3', 'x'))
		r.q.kick('load')
		await flush()
		for (let i = 0; i < 10; i++) { t += 3_000; await r.t.fire() }
		expect(calls.length).toBeLessThanOrEqual(2) // 30 s of back-off ticks (3 s apart): the load attempt and at most one more
	})
})

describe('the production defaults are pinned', () => {
	it('the heartbeat default is 30 s and chat.tsx does not override it; a queue made without the option arms a 30 s timer', async () => {
		const q = await import('./sendQueue')
		expect(q.DEFAULT_HEARTBEAT_MS).toBe(30_000)
		expect(q.DEFAULT_CONFIRMED_RETRY_MS).toBe(180_000)
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const chat = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8') as string
		const at = chat.indexOf('const queue = createSendQueue({')
		const block = chat.slice(at, chat.indexOf('sendQueueRef.current = queue', at))
		expect(at).toBeGreaterThan(0)
		expect(block).not.toMatch(/heartbeatMs|confirmedRetryMs/)
		const t = timers()
		const disk = memoryDisk()
		const queue = q.createSendQueue({ store: createQueueStore({ eoa: EOA, doc: disk.adapter, codec: base64JsonCodec() }), peer: PEER, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, setTimer: t.setTimer, clearTimer: t.clearTimer, isVisible: () => true })
		await queue.enqueue(mk('hbd', 'x'))
		expect(t.liveMs()).toContain(30_000)
		queue.dispose()
	})
})
