/**
 * @jest-environment node
 *
 * the mailbox ACK of an inbound row waits for the history append (library mode), through the real settle step and the real wait (inboundDurable.ts).
 * Synthetic hashes and lines only; no account data. The wait uses an injected sleep (no real delay) and a short real timeout for the hang case.
 */
import { settleInboundBatch, type InboundBatchSettleDeps } from './inboundBatchSettle'
import { durablePendingCount, durableStats, isDurablePending, remoteUnsentInboundSendIds, resetDurablePendingForTest, startDurableAck, subscribeUnsavedInbound, unsavedInboundSendIds, type DurableMirror } from './inboundDurable'
import { qaEventList } from '../utils/qaAckOrder'
import { newInboundLists, recordInboundLine, settleInputOf } from './inboundRowRecord'

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }
const sleepNow = async (): Promise<void> => undefined

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T,>(): Deferred<T> => {
	let resolve!: (v: T) => void
	const promise = new Promise<T>((r) => { resolve = r })
	return { promise, resolve }
}

/** a mirror whose first attempt is `first` and whose retries answer from `retries` (then false) */
function mirrorOf(first: Promise<boolean>, retries: Array<boolean | Promise<boolean>>, log: string[]): DurableMirror {
	let n = 0
	return {
		done: first,
		retry: () => {
			log.push(`retry#${n + 1}`)
			const v = retries[n++]
			return Promise.resolve(v === undefined ? false : v)
		},
	}
}

const stoppers: Array<() => void> = []
function harness(opts: { lineHash: Record<string, string>; commit?: () => Promise<boolean>; browser?: boolean }) {
	const log: string[] = []
	const acked: string[] = []
	const memory = new Set<string>()
	let stopped = false
	stoppers.push(() => { stopped = true })
	// like the page: `release` removes the line from the pending map and `hashesOf` reads what is still pending (a lookup after the release answers nothing)
	const released = new Set<string>()
	const deps: InboundBatchSettleDeps = {
		target: {
			browser: opts.browser ?? true,
			alreadyAcked: () => false,
			ackMailbox: (h) => { log.push(`ack:${h.join(',')}`); acked.push(...h) },
			ackDisplayed: (h) => { log.push(`ackDisplayed:${h.join(',')}`) },
		},
		hashesOf: (lines) => lines.filter((l) => !released.has(l)).map((l) => opts.lineHash[l]).filter((h): h is string => !!h),
		markHashes: (h) => { log.push(`mark:${h.join(',')}`); const added = h.filter((x) => !memory.has(x)); added.forEach((x) => memory.add(x)); return added },
		unmarkHashes: (h) => { log.push(`unmark:${h.join(',')}`); h.forEach((x) => memory.delete(x)) },
		commit: async () => { log.push('commit'); return opts.commit ? opts.commit() : true },
		release: (lines) => { log.push('release'); lines.forEach((l) => released.add(l)) },
		durableOptions: { sleep: async (ms) => { log.push(`sleep:${ms}`); await new Promise((r) => setTimeout(r, 1)) }, waitMs: 50, backoffMs: [10, 20], alive: () => !stopped },
	}
	return { deps, log, acked, memory }
}

beforeEach(() => resetDurablePendingForTest())
afterEach(() => { while (stoppers.length) (stoppers.pop() as () => void)() }) // every retry loop of a test ends with the test

describe('library mode: the mailbox ACK waits for the confirmed history append', () => {
	it('1. no ACK before the append is confirmed; ACK only after it; ACK is the last step', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const append = deferred<boolean>()
		const m = mirrorOf(append.promise, [], h.log)
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await flush()
		expect(h.acked).toEqual([]) // commit and release happened, the append is not confirmed: no ACK
		expect(h.log).toEqual(['commit', 'release']) // no marker before the commit for a row that waits for its append
		expect(isDurablePending(H(1))).toBe(true)
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
		expect(h.log[h.log.length - 1]).toBe('ack:' + H(1))
		expect(isDurablePending(H(1))).toBe(false)
	})

	it('2. settle itself does not wait: it returns right after the commit (the write lock ends with the commit, not with the append)', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const m = mirrorOf(new Promise<boolean>(() => undefined), [], h.log) // never confirms
		const done = await Promise.race([settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps), new Promise<string>((r) => setTimeout(() => r('hung'), 200))])
		expect(done).toBe(true)
	})

	it('3. only the dropped line is ACKed right after the commit; a row or a duplicate with no append to wait for is never ACKed here; the durable row and the durable duplicate wait', async () => {
		const h = harness({ lineHash: { ROW: H(1), DROP: H(2), DUP: H(3), REC: H(4), DUPD: H(5) } })
		const append = deferred<boolean>()
		const appendDup = deferred<boolean>()
		await settleInboundBatch(
			{ rowLines: ['ROW', 'REC'], duplicateLines: ['DUP', 'DUPD'], dropLines: ['DROP'], durable: new Map([['ROW', mirrorOf(append.promise, [], h.log)], ['DUPD', mirrorOf(appendDup.promise, [], h.log)]]) },
			h.deps,
		)
		await flush()
		expect(h.acked).toEqual([H(2)]) // the dropped line only; the row and the duplicate with no append (REC, DUP) are never ACKed here
		expect(h.log.filter((x) => x.startsWith('mark:'))).toEqual(['mark:' + H(2)]) // and only the dropped line is marked before the commit
		append.resolve(true)
		appendDup.resolve(true)
		await flush()
		expect(h.acked.filter((x) => x === H(1))).toHaveLength(1)
		expect(h.acked.filter((x) => x === H(5))).toHaveLength(1) // the durable duplicate: ACKed after its own append
		expect(h.acked.filter((x) => x === H(3) || x === H(4))).toHaveLength(0)
		expect(h.acked).toHaveLength(3)
	})

	it('4. an append that fails: no ACK, no marker at any time before the confirmation, the append is asked again after a back-off, and the ACK follows only the confirmed retry (marker set first, right before the ACK)', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const m = mirrorOf(Promise.resolve(false), [false, true], h.log)
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 60))
		expect(h.acked).toEqual([H(1)])
		const steps = h.log.filter((x) => /^(unmark|retry|mark|ack|sleep)/.test(x))
		expect(steps).toEqual(['sleep:10', 'retry#1', 'sleep:20', 'retry#2', 'mark:' + H(1), 'ack:' + H(1)])
		// the one mark comes after the confirmed append and right before the ACK; none before the commit, none during the failures
		expect(h.log.indexOf('mark:' + H(1))).toBeGreaterThan(h.log.indexOf('commit'))
	})

	it('5. an append that hangs counts as no confirmation after the wait; the retry then confirms and the ACK goes out once', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const m = mirrorOf(new Promise<boolean>(() => undefined), [true], h.log)
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 150)) // waitMs is 50
		await flush(20)
		expect(h.acked).toEqual([H(1)])
		expect(h.log.some((x) => x.startsWith('mark:'))).toBe(true) // set after the confirmed retry
		expect(h.log.indexOf('mark:' + H(1))).toBeLessThan(h.log.indexOf('ack:' + H(1)))
		expect(h.log.some((x) => x === 'retry#1')).toBe(true)
	})

	it('6. a retry that rejects is a failure, not a crash', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		let n = 0
		const m: DurableMirror = { done: Promise.resolve(false), retry: () => (++n === 1 ? Promise.reject(new Error('worker gone')) : Promise.resolve(true)) }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 60))
		expect(h.acked).toEqual([H(1)])
		expect(n).toBe(2)
	})

	it('7. a page that moved to another account stops the wait: never an ACK, the hash stays un-marked (the mailbox redelivers), nothing stays pending', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		let alive = true
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => alive, sleep: async () => { await new Promise((r) => setTimeout(r, 1)); alive = false } }
		const m = mirrorOf(Promise.resolve(false), [false, false, false], h.log)
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 60))
		expect(h.acked).toEqual([])
		expect(h.memory.has(H(1))).toBe(false)
		expect(durablePendingCount()).toBe(0)
	})

	it('8. a failed commit: no ACK, no wait started, no marker was ever set for the waiting row (nothing to roll back)', async () => {
		const h = harness({ lineHash: { L1: H(1) }, commit: async () => false })
		const m = mirrorOf(Promise.resolve(true), [], h.log)
		expect(await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)).toBe(false)
		await flush(20)
		expect(h.acked).toEqual([])
		expect(durablePendingCount()).toBe(0)
		expect(h.log.filter((x) => x.startsWith('mark:'))).toEqual([])
		expect(h.memory.size).toBe(0)
	})

	it('9. a redelivered copy of a hash whose append is still pending is NOT ACKed by its own batch (the page sees it as a duplicate); the single wait ACKs it once', async () => {
		const h = harness({ lineHash: { L1: H(1), L1AGAIN: H(1) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await settleInboundBatch({ rowLines: [], duplicateLines: ['L1AGAIN'], dropLines: [] }, h.deps) // the replay path (App.tsx confirmAlreadyHandled)
		await flush()
		expect(h.acked).toEqual([])
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
	})

	it('10. the same hash given twice starts one wait, not two', async () => {
		const acks: string[] = []
		const a = deferred<boolean>()
		const m = { done: a.promise, retry: async () => true }
		const p = startDurableAck([{ hash: H(1), mirror: m }, { hash: H(1), mirror: m }], { ackMailbox: (h) => acks.push(...h), markHashes: () => undefined, unmarkHashes: () => undefined }, { sleep: sleepNow })
		a.resolve(true)
		await p
		expect(acks).toEqual([H(1)])
	})

	it('11. native target: a durable map is ignored, the ACK goes the old way (ackDisplayed after the commit), no wait is started', async () => {
		const h = harness({ lineHash: { L1: H(1) }, browser: false })
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', mirrorOf(new Promise<boolean>(() => undefined), [], h.log)]]) }, h.deps)
		expect(h.log).toEqual(['commit', 'release', 'ackDisplayed:' + H(1)])
		expect(durablePendingCount()).toBe(0)
	})

	it('12. a browser batch with no append for its row (no durable map): only the dropped line is marked and ACKed; the row is not (the mailbox sends it again)', async () => {
		const h = harness({ lineHash: { L1: H(1), D: H(2) } })
		await settleInboundBatch({ rowLines: ['L1'], dropLines: ['D'] }, h.deps)
		expect(h.log).toEqual(['mark:' + H(2), 'commit', 'release', 'ack:' + H(2)])
	})
})

describe('a failing append is visible: counts in the log lines and in the stats, never an ACK', () => {
	it('13. every failed attempt writes one counting line (attempt, pending, failures); a release after failures says so; no hash, id or content is in a line', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const lines: string[] = []
		h.deps.durableOptions = { ...h.deps.durableOptions, log: (m) => lines.push(m) }
		const m = mirrorOf(Promise.resolve(false), [false, true], h.log)
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 60))
		expect(lines).toHaveLength(3)
		expect(lines[0]).toMatch(/not confirmed, mailbox ACK held.*attempt=1 pending=1 failures=1$/)
		expect(lines[1]).toMatch(/attempt=2 pending=1 failures=2$/)
		expect(lines[2]).toMatch(/ACK sent after a confirmed append, after 2 failed attempt\(s\); pending=0 failures=2$/)
		for (const l of lines) expect(l).not.toMatch(/0x[0-9a-f]{8}|L1/)
		expect(durableStats()).toEqual({ pending: 0, failures: 2, retries: 2, confirmed: 1, abandoned: 0 })
	})

	it('14. a line that keeps failing stays un-ACKed and pending while the page lives; the counters keep growing; the loop ends only with the page / account', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const m: DurableMirror = { done: Promise.resolve(false), retry: async () => false }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 80))
		expect(h.acked).toEqual([])
		expect(isDurablePending(H(1))).toBe(true)
		expect(durableStats().failures).toBeGreaterThanOrEqual(3)
		stoppers.forEach((f) => f()) // the page / account goes
		await new Promise((r) => setTimeout(r, 30))
		expect(isDurablePending(H(1))).toBe(false)
		expect(durableStats().abandoned).toBe(1)
		expect(h.acked).toEqual([])
	})
})

describe('recording: a new row carries its append, nothing else does', () => {
	const m: DurableMirror = { done: Promise.resolve(true), retry: async () => true }
	it('a mirror that returns its append makes the line durable-pending; settleInputOf passes it on', () => {
		const lists = newInboundLists()
		recordInboundLine(lists, 'L1', true, { mirror: () => m, write: () => undefined })
		expect(lists.stored).toEqual(['L1'])
		expect(lists.durable?.get('L1')).toBe(m)
		expect(settleInputOf(lists).durable?.get('L1')).toBe(m)
	})
	it('a mirror with no return and a batch without any append leave no durable field; a duplicate copy that is given an append keeps it', () => {
		const lists = newInboundLists()
		recordInboundLine(lists, 'A', true, { mirror: () => undefined, write: () => undefined })
		expect(lists.durable).toBeUndefined()
		expect(Object.keys(settleInputOf(lists))).toEqual(['rowLines', 'duplicateLines', 'dropLines'])
		recordInboundLine(lists, 'B', false, { mirror: () => m, write: () => undefined }) // a duplicate: the mirror is asked too
		expect(lists.durable?.get('B')).toBe(m)
	})
	it('a write that throws leaves the line unrecorded, durable or not', () => {
		const lists = newInboundLists()
		expect(() => recordInboundLine(lists, 'L1', true, { mirror: () => m, write: () => { throw new Error('write') } })).toThrow('write')
		expect(lists.stored).toEqual([])
		expect(lists.durable).toBeUndefined()
	})
})

describe('the dedupe marker of a waiting row is set only after the confirmed append', () => {
	it('the settle step marks the other lines of the batch before the commit but NOT the waiting row; the row is marked after the confirmation, before its ACK', async () => {
		const h = harness({ lineHash: { ROW: H(1), DROP: H(2), DUP: H(3) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['ROW'], duplicateLines: ['DUP'], dropLines: ['DROP'], durable: new Map([['ROW', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await flush()
		expect(h.log.filter((x) => x.startsWith('mark:'))).toEqual(['mark:' + H(2)]) // only the dropped line; never the waiting row, never a duplicate
		expect(h.memory.has(H(1))).toBe(false) // what a commit would carry to disk: no marker for the row whose library copy is not confirmed
		append.resolve(true)
		await flush()
		expect(h.memory.has(H(1))).toBe(true)
		expect(h.log.indexOf('mark:' + H(1))).toBeLessThan(h.log.indexOf('ack:' + H(1)))
	})
	it('a row that has no append to wait for is NOT marked and NOT ACKed in the browser: no marker may claim a copy that is not there', async () => {
		const h = harness({ lineHash: { ROW: H(1) } })
		await settleInboundBatch({ rowLines: ['ROW'], dropLines: [] }, h.deps)
		expect(h.log).toEqual(['commit', 'release'])
		expect(h.memory.size).toBe(0)
		expect(h.acked).toEqual([])
	})
})

describe('a displayed inbound message whose library write is not confirmed is "not saved" until it is saved', () => {
	const sid = 'send-unsaved-1'
	it('U1 a failing write marks the sendId unsaved, the confirmation clears it, and listeners hear both changes', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const heard: string[][] = []
		const off = subscribeUnsavedInbound(() => heard.push([...unsavedInboundSendIds()]))
		const m: DurableMirror = { ...mirrorOf(Promise.resolve(false), [false, true], h.log), sendId: sid }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await flush()
		expect(unsavedInboundSendIds().has(sid)).toBe(true) // the first attempt failed: shown, not saved
		await new Promise((r) => setTimeout(r, 60))
		expect(h.acked).toEqual([H(1)])
		expect(unsavedInboundSendIds().has(sid)).toBe(false) // saved: the mark is gone by itself
		off()
		expect(heard).toEqual([[sid], []])
	})
	it('U2 a message with no failure is never marked; a row without a sendId cannot be marked and is not', async () => {
		const h = harness({ lineHash: { L1: H(1), L2: H(2) } })
		const a: DurableMirror = { done: Promise.resolve(true), retry: async () => true, sendId: 'ok-1' }
		const b: DurableMirror = { done: Promise.resolve(false), retry: async () => true } // fails once, no sendId
		let seen = false
		const off = subscribeUnsavedInbound(() => { seen = true })
		await settleInboundBatch({ rowLines: ['L1', 'L2'], dropLines: [], durable: new Map([['L1', a], ['L2', b]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 40))
		off()
		expect(seen).toBe(false)
		expect(unsavedInboundSendIds().size).toBe(0)
		expect(h.acked.sort()).toEqual([H(1), H(2)])
	})
	it('U3 a page that moved to another account stops the wait and drops the mark (the mailbox redelivers on the next listen)', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		let alive = true
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => alive, sleep: async () => { await new Promise((r) => setTimeout(r, 1)); alive = false } }
		const m: DurableMirror = { ...mirrorOf(Promise.resolve(false), [false], h.log), sendId: sid }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 40))
		expect(h.acked).toEqual([])
		expect(unsavedInboundSendIds().has(sid)).toBe(false)
	})
	it('U3b the account moves WHILE the append is in flight and the append then fails: the page stops at once, never an ACK, and the mark does not stay for a message of another account', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		let alive = true
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => alive }
		const append = deferred<boolean>()
		const m: DurableMirror = { ...mirrorOf(append.promise, [true], h.log), sendId: sid }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		alive = false // the account changed while the first append was still running
		append.resolve(false) // and it did not confirm
		await new Promise((r) => setTimeout(r, 30))
		expect(h.acked).toEqual([])
		expect(h.log.some((x) => x.startsWith('retry#'))).toBe(false) // stopped: no second attempt for a page that is gone
		expect(unsavedInboundSendIds().has(sid)).toBe(false)
		expect(durablePendingCount()).toBe(0)
	})
	it('U4 a write that stays failing keeps the mark through every retry; the mark is on after the first failure and until a confirmation', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const last = deferred<boolean>()
		const m: DurableMirror = { ...mirrorOf(Promise.resolve(false), [false, false, last.promise], h.log), sendId: sid }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 30)) // first attempt and two retries have run; the third retry is waiting
		expect(h.log.filter((x) => x.startsWith('retry#'))).toEqual(['retry#1', 'retry#2', 'retry#3'])
		expect(unsavedInboundSendIds().has(sid)).toBe(true)
		expect(h.acked).toEqual([])
		last.resolve(true)
		await new Promise((r) => setTimeout(r, 10))
		expect(h.acked).toEqual([H(1)])
		expect(unsavedInboundSendIds().has(sid)).toBe(false)
	})
})

describe('a line that comes again in the same session does not mark a hash whose wait is running', () => {
	it('a replay batch for a pending hash marks nothing for it and ACKs nothing for it; the wait still marks after the confirmation', async () => {
		const h = harness({ lineHash: { ROW: H(1), REPLAY: H(1), OTHER: H(2) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['ROW'], dropLines: [], durable: new Map([['ROW', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await flush()
		expect(h.log.some((x) => x.startsWith('mark:'))).toBe(false)
		// the same line again in the session (a reconnect, a foreground resume): the replay path of App.tsx has no durable map; it carries another line too
		await settleInboundBatch({ rowLines: [], duplicateLines: ['REPLAY'], dropLines: ['OTHER'] }, h.deps)
		await flush()
		expect(h.log.filter((x) => x.startsWith('mark:'))).toEqual(['mark:' + H(2)]) // the other line is marked; the pending hash never
		expect(h.memory.has(H(1))).toBe(false)
		expect(h.acked).toEqual([H(2)]) // and it is not ACKed by the replay either
		append.resolve(true)
		await flush()
		expect(h.memory.has(H(1))).toBe(true)
		expect(h.acked).toEqual([H(2), H(1)])
	})
	it('once the wait is over (confirmed), a later replay of the same hash that carries the marker (the replay plan passes it as a dropped line) is ACKed again; as a duplicate with no append it is not', async () => {
		const h = harness({ lineHash: { ROW: H(1), REPLAY: H(1), REPLAY2: H(1) } })
		await settleInboundBatch({ rowLines: ['ROW'], dropLines: [], durable: new Map([['ROW', mirrorOf(Promise.resolve(true), [], h.log)]]) }, h.deps)
		await flush(20)
		expect(h.acked).toEqual([H(1)])
		await settleInboundBatch({ rowLines: [], duplicateLines: ['REPLAY2'], dropLines: [] }, h.deps)
		expect(h.acked.filter((x) => x === H(1)).length).toBe(1) // a duplicate copy with no append: not ACKed
		await settleInboundBatch({ rowLines: [], dropLines: ['REPLAY'] }, h.deps) // the replay plan: a marker is there, so the ACK is confirmed again
		expect(h.acked.filter((x) => x === H(1)).length).toBe(2)
	})
})

describe('every durable row waits for its append, whatever the persistence mode is', () => {
	it('there is no question after the commit any more: a durable row is held until its append is confirmed (record-mode accounts too)', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await flush()
		expect(h.acked).toEqual([]) // not ACKed after the commit
		expect(isDurablePending(H(1))).toBe(true)
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
	})
	it('the settle step has no hold switch: a dependency named holdForAppend changes nothing (static)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require('fs').readFileSync(require('path').join(__dirname, 'inboundBatchSettle.ts'), 'utf8') as string
		expect(src).not.toMatch(/holdForAppend/)
	})
})

describe('checklist: no path releases a message line early', () => {
	it('C1a a mirror that returns nothing (no row found, native) or throws: a throwing mirror leaves the line unrecorded (never settled, never ACKed); one that returns nothing leaves a row with no wait, never ACKed', async () => {
		const lists = newInboundLists()
		expect(() => recordInboundLine(lists, 'T', true, { mirror: () => { throw new Error('mirror threw') }, write: () => undefined })).toThrow('mirror threw')
		expect(lists.stored).toEqual([])
		recordInboundLine(lists, 'N', true, { mirror: () => undefined, write: () => undefined })
		const h = harness({ lineHash: { N: H(1) } })
		await settleInboundBatch(settleInputOf(lists), h.deps)
		await flush()
		expect(h.acked).toEqual([])
	})
	it('C1b the same hash twice: the later line is filtered out of the wait (one wait only) and is not ACKed by anything else; the one wait ACKs once', async () => {
		const h = harness({ lineHash: { A: H(1), B: H(1) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['A', 'B'], dropLines: [], durable: new Map([['A', mirrorOf(append.promise, [], h.log)], ['B', mirrorOf(Promise.resolve(true), [], h.log)]]) }, h.deps)
		await flush()
		expect(h.acked).toEqual([])
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
	})
	it('a hash shared by a drop line and a row line of one batch counts as a row: the drop line does not ACK it (by hash, not by line)', async () => {
		const h = harness({ lineHash: { ROW: H(1), DROP: H(1) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['ROW'], dropLines: ['DROP'], durable: new Map([['ROW', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await flush()
		expect(h.acked).toEqual([])
		expect(h.log.some((x) => x.startsWith('mark:'))).toBe(false)
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
	})
	it('an append that never answers: after the wait timeout the loop asks again; nothing is ACKed by the timeout, the commit or any other path', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		const m: DurableMirror = { done: new Promise<boolean>(() => undefined), retry: () => new Promise<boolean>(() => undefined) }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', m]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 160)) // waitMs is 50: several timeouts have passed
		expect(h.acked).toEqual([])
		expect(isDurablePending(H(1))).toBe(true) // still waiting, still retrying
		expect(durableStats().failures).toBeGreaterThanOrEqual(2)
	})
	it('the page is no longer alive when the settle step runs: no ACK from the settle step and none from the wait', async () => {
		const h = harness({ lineHash: { L1: H(1), D: H(2) } })
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => false }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: ['D'], durable: new Map([['L1', mirrorOf(Promise.resolve(false), [true], h.log)]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 30))
		expect(h.acked).toEqual([H(2)]) // the dropped line only
		expect(durablePendingCount()).toBe(0)
	})
})

describe('a later batch cannot mark a hash whose wait is running', () => {
	it('a DROP line that shares its hash with a row whose wait is running is neither marked nor ACKed by the later batch; the wait still marks and ACKs once', async () => {
		const h = harness({ lineHash: { ROW: H(1), DROP2: H(1) } })
		const append = deferred<boolean>()
		await settleInboundBatch({ rowLines: ['ROW'], dropLines: [], durable: new Map([['ROW', mirrorOf(append.promise, [], h.log)]]) }, h.deps)
		await flush()
		await settleInboundBatch({ rowLines: [], dropLines: ['DROP2'] }, h.deps) // a later batch (a replay passed as a dropped line) with the same hash
		await flush()
		expect(h.log.some((x) => x.startsWith('mark:'))).toBe(false)
		expect(h.acked).toEqual([])
		append.resolve(true)
		await flush()
		expect(h.acked).toEqual([H(1)])
		expect(h.memory.has(H(1))).toBe(true)
	})
})

describe('an abandoned wait (the account changed) makes the page forget the line', () => {
	it('onAbandoned gets the mirror of the abandoned wait (with the page key) once; a wait that ends by a confirmed append does not call it', async () => {
		const abandoned: Array<string | undefined> = []
		const h = harness({ lineHash: { L1: H(1), L2: H(2) } })
		let alive = true
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => alive, sleep: async () => { await new Promise((r) => setTimeout(r, 1)); alive = false }, onAbandoned: (m) => { abandoned.push(m.msgKey) } }
		const failing: DurableMirror = { ...mirrorOf(Promise.resolve(false), [false], h.log), msgKey: 'key-1' }
		const ok: DurableMirror = { done: Promise.resolve(true), retry: async () => true, msgKey: 'key-2' }
		await settleInboundBatch({ rowLines: ['L1', 'L2'], dropLines: [], durable: new Map([['L1', failing], ['L2', ok]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 40))
		expect(abandoned).toEqual(['key-1'])
		expect(h.acked).toEqual([H(2)])
	})
	it('a callback that throws changes nothing (the wait still ends, nothing is ACKed)', async () => {
		const h = harness({ lineHash: { L1: H(1) } })
		h.deps.durableOptions = { ...h.deps.durableOptions, alive: () => false, onAbandoned: () => { throw new Error('bookkeeping failed') } }
		await settleInboundBatch({ rowLines: ['L1'], dropLines: [], durable: new Map([['L1', { ...mirrorOf(Promise.resolve(false), [], h.log), msgKey: 'k' }]]) }, h.deps)
		await new Promise((r) => setTimeout(r, 30))
		expect(h.acked).toEqual([])
		expect(durablePendingCount()).toBe(0)
	})
})

describe('an append that failed at a REMOTE step is "saved here, remote not committed", not "not saved"', () => {
	const HOOK = 'REACT_APP_QA_ACK_ORDER_HOOK'
	const saved = process.env[HOOK]
	afterEach(() => { if (saved === undefined) delete process.env[HOOK]; else process.env[HOOK] = saved })
	const run = async (failure: DurableMirror['failure'], hook: boolean) => {
		if (hook) process.env[HOOK] = 'true'; else delete process.env[HOOK]
		const acked: string[] = []
		let stage: 'down' | 'up' = 'down'
		const seenRemote: boolean[] = []
		const seenLocal: boolean[] = []
		const mirror: DurableMirror = { done: Promise.resolve(false), retry: async () => { seenRemote.push(remoteUnsentInboundSendIds().has('send-r3')); seenLocal.push(unsavedInboundSendIds().has('send-r3')); return stage === 'up' }, sendId: 'send-r3', failure }
		const before = qaEventList().length
		await startDurableAck([{ hash: H(0xabcdef12), mirror }], { ackMailbox: (h) => acked.push(...h), markHashes: () => undefined, unmarkHashes: () => undefined }, {
			sleep: async () => { stage = 'up' },
			waitMs: 50, backoffMs: [1],
		})
		return { acked, seenRemote, seenLocal, events: qaEventList().slice(before) }
	}
	it('a remote step code: the remote mark is set (not the unsaved one) while it fails, both clear on the confirmed append, the ACK follows only then', async () => {
		const r = await run(() => 'pointer', true)
		expect(r.seenRemote).toEqual([true])
		expect(r.seenLocal).toEqual([false])
		expect(r.acked).toEqual([H(0xabcdef12)])
		expect([remoteUnsentInboundSendIds().has('send-r3'), unsavedInboundSendIds().has('send-r3')]).toEqual([false, false])
	})
	it('the hook event remote_fail carries the sendId tail, the hash tail (8) and the step code, nothing else', async () => {
		const r = await run(() => 'upload', true)
		const e = r.events.filter((x) => x.n === 'remote_fail')
		expect(e).toHaveLength(1)
		expect(e[0]).toMatchObject({ n: 'remote_fail', id: 'send-r3'.slice(-8), x: 'habcdef12_upload' })
		expect(Object.keys(e[0] as object).sort()).toEqual(['at', 'id', 'n', 'x'])
	})
	it('not a hook build: the same failure emits no event (the inline gate)', async () => {
		const r = await run(() => 'pointer', false)
		expect(r.events).toEqual([])
		expect(r.seenRemote).toEqual([true]) // the page behaviour itself does not depend on the hook
	})
	it('a local failure, an unknown reason, or a failure function that throws: "not saved", and no remote_fail event', async () => {
		for (const f of [() => 'local' as const, () => undefined, () => { throw new Error('x') }, undefined]) {
			resetDurablePendingForTest()
			const r = await run(f as DurableMirror['failure'], true)
			expect(r.seenLocal).toEqual([true])
			expect(r.seenRemote).toEqual([false])
			expect(r.events.filter((x) => x.n === 'remote_fail')).toEqual([])
			expect(r.acked).toEqual([H(0xabcdef12)])
		}
	})
})


describe('the retry and the two status marks', () => {
	const tickFor = (ms: number) => new Promise((r) => setTimeout(r, ms))
	it('after a failed first attempt the retry is asked (the first promise is not just awaited again), and its confirmation ACKs', async () => {
		let asked = 0
		const acked: string[] = []
		let stop = false
		void startDurableAck([{ hash: H(901), mirror: { done: Promise.resolve(false), retry: async () => { asked += 1; return true } } }], { ackMailbox: (h) => { acked.push(...h) }, markHashes: () => undefined, unmarkHashes: () => undefined }, { sleep: () => tickFor(1), waitMs: 50, alive: () => !stop })
		await tickFor(40)
		stop = true
		expect(asked).toBeGreaterThanOrEqual(1)
		expect(acked).toEqual([H(901)])
	})
	it('a local failure followed by a remote one leaves ONLY "saved here, remote not committed"', async () => {
		let n = 0
		let stop = false
		let why: 'local' | 'pointer' = 'local'
		const done = startDurableAck([{ hash: H(902), mirror: { done: Promise.resolve(false), retry: async () => { n += 1; if (n === 2) why = 'pointer'; return false }, sendId: 'send-two', failure: () => why } }], { ackMailbox: () => undefined, markHashes: () => undefined, unmarkHashes: () => undefined }, { sleep: () => tickFor(2), waitMs: 50, alive: () => !stop })
		await tickFor(60)
		expect([remoteUnsentInboundSendIds().has('send-two'), unsavedInboundSendIds().has('send-two')]).toEqual([true, false])
		stop = true
		await done
	})
})
