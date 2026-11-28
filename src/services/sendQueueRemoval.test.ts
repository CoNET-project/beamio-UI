/**
 * @jest-environment node
 */
// WHEN the durable queue removes an item's document: observed on the real queue and the real queue store over a document table that records every removal. A document is removed in two cases only:
// (a) the attempt ended `sent` AND the sent state is on disk, (b) the user dropped the message. Nothing else (a failed, unknown, held, waiting or awaiting result, a throw, a missing sent state, time, a reload in the
// middle of a send, a disposed queue, a start of the queue) removes it.
import { readFileSync } from 'fs'
import { join } from 'path'
import { base64JsonCodec } from './chatDraftStore'
import { createQueueStore, createSendQueue, queueDocId, type AttemptResult, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { messagesForUnlisted } from './sendFlow'
import { heldWireFromMessage } from './heldWire'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const ID = queueDocId(EOA, 's1')
const ITEM: QueueItem = { v: 1, sendId: 's1', peer: PEER, text: 'synthetic', createdAt: 1, queuedAt: 1 }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }

function table() {
	const docs = new Map<string, string>()
	const removals: string[] = []
	const fault = { remove: false }
	const doc: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: async (id, t) => { docs.set(id, t) },
		remove: async (id) => { removals.push(id); if (fault.remove) throw new Error('remove_failed'); docs.delete(id) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)),
	}
	return { docs, removals, fault, doc }
}

/** one page life over the shared table: manual timers and a manual clock */
function page(t: ReturnType<typeof table>, opts: { resume?: (i: QueueItem) => Promise<AttemptResult>; persistConfirmed?: () => Promise<boolean> } = {}) {
	const timers: Array<{ fn: () => void; live: boolean }> = []
	const clock = { now: 1_000_000 }
	const resumed: string[] = []
	const queue = createSendQueue({
		store: createQueueStore({ eoa: EOA, doc: t.doc, codec: base64JsonCodec() }),
		peer: PEER,
		resume: async (i) => { resumed.push(i.sendId); return opts.resume ? opts.resume(i) : { kind: 'unknown' } },
		persistConfirmed: opts.persistConfirmed ?? (async () => false),
		setTimer: (fn) => { const h = { fn, live: true }; timers.push(h); return h },
		clearTimer: (h) => { (h as { live: boolean }).live = false },
		now: () => clock.now,
		isVisible: () => true,
	} as Parameters<typeof createSendQueue>[0])
	/** fire the pending timers n times, one hour apart (retry back-off and heartbeat) */
	const age = async (n: number) => { for (let i = 0; i < n; i++) { clock.now += 3600_000; for (const h of timers.filter((x) => x.live)) { h.live = false; h.fn() } await flush() } }
	return { queue, timers, clock, age, resumed }
}

const notSent: Array<[string, AttemptResult]> = [['failed', { kind: 'failed' }], ['unknown', { kind: 'unknown' }], ['held', { kind: 'held' }], ['waiting', { kind: 'waiting' }], ['awaiting', { kind: 'awaiting', persisted: true }], ['sent, sent state NOT on disk', { kind: 'sent', persisted: false }]]

describe('the queue keeps the document in every case that is not "sent and on disk" or the user\'s drop', () => {
	for (const [name, result] of notSent) {
		it(`result "${name}": no removal, also after 48 hours of retry and heartbeat ticks`, async () => {
			const t = table()
			const p = page(t, { resume: async () => result })
			await p.queue.enqueue(ITEM, { inline: true })
			await p.queue.run('s1', async () => result, { inline: true })
			await p.age(48)
			expect(t.removals).toEqual([])
			expect(t.docs.has(ID)).toBe(true)
			expect(p.queue.has('s1')).toBe(true)
		})
	}

	it('an attempt that throws: no removal', async () => {
		const t = table()
		const p = page(t)
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.run('s1', async () => { throw new Error('boom') }, { inline: true })
		await p.age(5)
		expect(t.removals).toEqual([])
		expect(t.docs.has(ID)).toBe(true)
	})

	it('a reload in the middle of a send (the attempt never ends; the queue is disposed; a new page loads and starts): no removal, the item is back as queued and is resumed', async () => {
		const t = table()
		const first = page(t)
		await first.queue.enqueue(ITEM, { inline: true })
		let end: (r: AttemptResult) => void = () => undefined
		const running = first.queue.run('s1', () => new Promise<AttemptResult>((r) => { end = r }), { inline: true })
		await flush()
		await first.age(24)
		first.queue.dispose()
		const next = page(t)
		await next.queue.load()
		expect(next.queue.stateOf('s1')).toBe('queued')
		next.queue.kick('load')
		await flush()
		expect(next.resumed).toEqual(['s1'])
		end({ kind: 'failed' }) // the old page's attempt ends late
		await running
		expect(t.removals).toEqual([])
		expect(t.docs.has(ID)).toBe(true)
	})

	it('confirmed with the sent state not on disk: the later passes remove ONLY once that state has landed, without sending again', async () => {
		const t = table()
		let landed = false
		let posts = 0
		const p = page(t, { persistConfirmed: async () => landed })
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.run('s1', async () => { posts += 1; return { kind: 'sent', persisted: false } }, { inline: true })
		await p.queue.run('s1', async () => { posts += 1; return { kind: 'unknown' } })
		expect(t.removals).toEqual([])
		landed = true
		await p.queue.run('s1', async () => { posts += 1; return { kind: 'unknown' } })
		expect(t.removals).toEqual([ID])
		expect(posts).toBe(1)
	})
})

describe('the two removals', () => {
	it('sent and on disk: exactly one removal of this document', async () => {
		const t = table()
		const p = page(t)
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.run('s1', async () => ({ kind: 'sent', persisted: true }), { inline: true })
		await p.age(5)
		expect(t.removals).toEqual([ID])
		expect(t.docs.has(ID)).toBe(false)
		expect(p.queue.has('s1')).toBe(false)
	})

	it('the user\'s drop: exactly one removal; a drop of a sendId the queue does not hold removes nothing', async () => {
		const t = table()
		const p = page(t)
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.drop('not-in-the-queue')
		expect(t.removals).toEqual([])
		await p.queue.drop('s1')
		expect(t.removals).toEqual([ID])
		expect(t.docs.has(ID)).toBe(false)
	})
})

describe('a removal that fails', () => {
	it('after "sent and on disk": the item stays confirmed, the next pass retries the removal without sending; after a restart the document is still there as queued', async () => {
		const t = table()
		t.fault.remove = true
		let posts = 0
		const p = page(t, { persistConfirmed: async () => true })
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.run('s1', async () => { posts += 1; return { kind: 'sent', persisted: true } }, { inline: true })
		expect(p.queue.stateOf('s1')).toBe('confirmed')
		expect(t.docs.has(ID)).toBe(true)
		const restarted = page(t)
		await restarted.queue.load()
		expect(restarted.queue.stateOf('s1')).toBe('queued')
		restarted.queue.dispose()
		t.fault.remove = false
		await p.queue.run('s1', async () => { posts += 1; return { kind: 'unknown' } })
		expect(posts).toBe(1)
		expect(t.docs.has(ID)).toBe(false)
	})

	it('on a drop (current behaviour, a known limit): this page forgets the item, the document stays, and after a restart it is queued, put back into the list and resumed', async () => {
		const t = table()
		t.fault.remove = true
		const p = page(t)
		await p.queue.enqueue(ITEM, { inline: true })
		await p.queue.drop('s1')
		expect(p.queue.has('s1')).toBe(false)
		expect(t.docs.has(ID)).toBe(true)
		const restarted = page(t)
		const items = await restarted.queue.load()
		expect(restarted.queue.stateOf('s1')).toBe('queued')
		const back = messagesForUnlisted(items, []) // the dropped message is not in the stored list: the restore puts it back
		expect(back.map((m) => [m.sendId, m.status])).toEqual([['s1', 'failed']])
		expect(heldWireFromMessage(back[0]!)).not.toBeNull() // and it can be rebuilt as a text wire, so a resume would send it
		restarted.queue.kick('load')
		await flush()
		expect(restarted.resumed).toEqual(['s1'])
	})
})

describe('where the removals can come from (read from the syntax tree, not from a count of text occurrences)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ts = require('typescript')
	const source = ts.createSourceFile('sendQueue.ts', readFileSync(join(__dirname, 'sendQueue.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
	const nameOf = (n: any): string | undefined => {
		if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText(source)
		if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) return n.parent.name.getText(source)
		return undefined
	}
	/** for every call of `callee`: the name of the nearest NAMED enclosing function */
	const callersOf = (callee: string): string[] => {
		const out = new Set<string>()
		const visit = (n: any) => {
			if (ts.isCallExpression(n) && n.expression.getText(source) === callee) {
				let p = n.parent
				while (p && !nameOf(p)) p = p.parent
				out.add(p ? (nameOf(p) as string) : '<top>')
			}
			ts.forEachChild(n, visit)
		}
		visit(source)
		return [...out].sort()
	}
	it('the document is removed only inside removeDocument (under the per-sendId lock), and removeDocument is called only by finish and by drop', () => {
		expect(callersOf('opts.store.remove')).toEqual(['removeDocument'])
		expect(callersOf('removeDocument')).toEqual(['drop', 'finish'])
	})
	it('in the application sources nothing calls drop(): no tap and no path of the conversation page removes a queue item', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat.match(/\.drop\(/g)).toBeNull()
		const calls = [...chat.matchAll(/retryFailedSend\(m\)/g)].map((m) => chat.slice(Math.max(0, m.index! - 90), m.index!))
		expect(calls.length).toBeGreaterThan(0)
		for (const before of calls.filter((b) => !/async function $/.test(b))) expect(before).toMatch(/on(Retry|Click)=\{/)
	})
})
