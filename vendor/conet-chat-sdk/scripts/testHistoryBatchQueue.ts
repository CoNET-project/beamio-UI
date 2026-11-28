/**
 * The batch rules, the per-entry queue and the commit step (src/worker/history-batch.ts) over an in-memory store and a chain model with one head and one nonce. Synthetic wallets and rows; no network.
 * Run: npx tsx scripts/testHistoryBatchQueue.ts
 */
import { ArchiveQueue, ArchiveQueueError, BatchWriter, BATCH_ENTRY_PREFIX, BATCH_FLIGHT_PREFIX, batchRetryDelay, decideFlight, historyRecordKey, type BatchNet, type BatchTrace, type Flight, type HeadSnapshot, type PointerAnswer, type QueuePersistence, pinCoversAll, type PinRequest, type PinResult } from '../src/worker/history-batch.js'

let failures = 0
let passes = 0
/** the state of an entry the head shows when the general cases run (their pin double always proves): archived */
const IN_HEAD = () => 'archived'
const check = (name: string, ok: boolean, detail?: unknown): void => {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined && !ok ? ` - ${JSON.stringify(detail)}` : ''}`)
}
const EOA = `0x${'aa'.repeat(20)}`
const OTHER = `0x${'bb'.repeat(20)}`
const PEER = `0x${'22'.repeat(20)}`
const KEY = new Uint8Array(32).fill(7)
const KEY2 = new Uint8Array(32).fill(9)

function memory(): QueuePersistence & { map: Map<string, unknown>; fault: { swallowSet?: boolean; swallowGet?: boolean; failKeys?: boolean } } {
	const map = new Map<string, unknown>()
	const fault: { swallowSet?: boolean; swallowGet?: boolean; failKeys?: boolean } = {}
	return {
		map,
		fault,
		// like the worker's real adapter: a failed get answers undefined and a failed set is ignored
		get: async (k) => (fault.swallowGet ? undefined : map.get(k)),
		set: async (k, v) => { if (!fault.swallowSet) map.set(k, v) },
		keys: async (p) => { if (fault.failKeys) throw new Error('keys_failed'); return [...map.keys()].filter((k) => k.startsWith(p)) },
	}
}

type Rec = { key: string }
function chain() {
	const indexes = new Map<string, Rec[]>()
	const c = {
		head: null as string | null,
		nonce: 0,
		made: 0,
		uploads: 0,
		submits: [] as Array<{ index: string; nonce: string }>,
		snapshots: 0,
		/** the order of the calls, to see that a snapshot precedes every submission */
		log: [] as string[],
		fault: {} as { snapshot?: boolean | number; upload?: boolean; answer?: PointerAnswer; apply?: boolean; loadIndex?: boolean },
		pinned: new Set<string>(),
		asked: [] as PinRequest[][],
		/** how the pin double distorts its answers */
		pinFault: null as null | ((r: PinResult, i: number, all: PinRequest[]) => PinResult | null),
		indexes,
		other(keys: string[]) {
			const next = `0xother${++c.made}`
			indexes.set(next, [...(c.head ? indexes.get(c.head)! : []), ...keys.map((key) => ({ key }))])
			c.head = next
			c.nonce += 1
		},
		keysInHead(): string[] { return c.head ? indexes.get(c.head)!.map((r) => r.key) : [] },
		net(pin: boolean | 'auto', hooks: { beforeSubmit?: () => void; afterPrepare?: () => Promise<void> | void } = {}): BatchNet<Rec> {
			return {
				readSnapshot: async () => {
					c.log.push('snapshot'); c.snapshots += 1
					if (c.fault.snapshot === true || (typeof c.fault.snapshot === 'number' && c.snapshots >= c.fault.snapshot)) return null
					return { head: c.head, nonce: String(c.nonce) }
				},
				loadIndex: async (head) => (c.fault.loadIndex ? null : { records: head ? indexes.get(head)! : [], keys: new Map((head ? indexes.get(head)! : []).map((r) => [r.key, { hash: `0xfrag-${r.key}`, length: r.key.length + 10 }])), indexLength: 99 }),
				prepare: async (records, entries) => {
					c.log.push('prepare')
					if (c.fault.upload) return null
					c.uploads += entries.length + 1
					const indexHash = `0xidx${++c.made}`
					indexes.set(indexHash, [...records, ...entries.map((e) => ({ key: e.key }))])
					await hooks.afterPrepare?.()
					return { index: { hash: indexHash, length: 99 }, objects: Object.fromEntries(entries.map((e) => [e.key, { hash: `0xfrag-${e.key}`, length: e.key.length + 10 }])), recordCount: indexes.get(indexHash)!.length }
				},
				submitPointer: async (flight: Flight, snapshot: HeadSnapshot) => {
					c.log.push('submit'); c.submits.push({ index: flight.indexHash, nonce: snapshot.nonce })
					hooks.beforeSubmit?.()
					if (snapshot.nonce !== String(c.nonce)) return 'conflict'
					const apply = c.fault.apply ?? (c.fault.answer === undefined)
					if (apply) { c.head = flight.indexHash; c.nonce += 1 }
					return c.fault.answer ?? 'ok'
				},
				...(pin === 'auto' ? { askPinned: async (requests: PinRequest[]) => requests.map((q) => ({ state: 'pinned', hash: q.hash, length: q.length, nonce: q.nonce, contentVerified: true })) } : {}),
				// test double only: 'pinned' for every request once the index is marked pinned, optionally distorted
				...(pin === true ? { askPinned: async (requests: PinRequest[]) => {
					c.asked.push(requests)
					if (!requests.some((q) => c.pinned.has(q.hash))) return []
					return requests.map((q, i) => { const r: PinResult = { state: 'pinned', hash: q.hash, length: q.length, nonce: q.nonce, contentVerified: true }; return c.pinFault ? c.pinFault(r, i, requests) : r }).filter((r): r is PinResult => r !== null)
				} } : {}),
			}
		},
	}
	return c
}

function rig(opts: { pin?: boolean; store?: ReturnType<typeof memory>; chain?: ReturnType<typeof chain>; eoa?: string; key?: Uint8Array; hooks?: Parameters<ReturnType<typeof chain>['net']>[1]; clock?: { t: number } } = {}) {
	const store = opts.store ?? memory()
	const ch = opts.chain ?? chain()
	const clock = opts.clock ?? { t: 1_000_000 }
	const trace: BatchTrace[] = []
	const archived: string[] = []
	const sleeps: number[] = []
	const queue = new ArchiveQueue(store, opts.eoa ?? EOA, opts.key ?? KEY)
	const writer = new BatchWriter<Rec>({ queue, net: ch.net(opts.pin ?? 'auto', opts.hooks), now: () => clock.t, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms) }, trace: (x) => trace.push(x), onArchived: (k) => archived.push(...k) })
	const add = async (id: string, body = `body of ${id}`) => writer.enqueue({ peer: PEER, dir: 'in', ts: clock.t, sendId: id, body })
	const states = async () => Object.fromEntries((await queue.list()).entries.map((e) => [e.key, e.state]))
	return { store, ch, clock, trace, archived, sleeps, queue, writer, add, states }
}
const ids = (n: number, p = 'm') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`)
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as ArchiveQueueError).code ?? String(e))

async function main(): Promise<void> {
	{ // 9 not due
		const r = rig(); for (const id of ids(9)) await r.add(id)
		const o = await r.writer.run()
		check('9 entries before the time: nothing is read, uploaded or submitted', o === 'waiting' && r.ch.uploads === 0 && r.ch.submits.length === 0 && r.ch.snapshots === 0, { o })
		check('9 entries: the next wake is 2 minutes after the first', (await r.writer.nextWakeAt()) === 1_000_000 + 120_000)
	}
	{ // 10th
		const r = rig(); for (const id of ids(9)) { await r.add(id); r.clock.t += 1_000 }
		await r.add('m10')
		check('the 10th entry is due at once (no added wait)', (await r.writer.nextWakeAt()) === r.clock.t)
		const o = await r.writer.run()
		check('10th entry: one batch, 10 fragments + 1 index, 1 pointer', o === 'committed' && r.ch.uploads === 11 && r.ch.submits.length === 1 && r.ch.keysInHead().length === 10, { o, u: r.ch.uploads })
		check('10th entry: trace says count trigger', r.trace.some((t) => t.event === 'trigger_count' && t.count === 10) && !r.trace.some((t) => t.event === 'trigger_age'))
	}
	{ // age, not postponed
		const r = rig(); await r.add('m1'); r.clock.t += 100_000; await r.add('m2'); r.clock.t += 19_999
		check('1 ms before 2 minutes after the first: waiting, although a newer entry exists', (await r.writer.run()) === 'waiting')
		r.clock.t += 1
		const o = await r.writer.run()
		check('at 2 minutes after the FIRST entry: written, the later entry with it', o === 'committed' && r.ch.keysInHead().join() === 'm1,m2' && r.trace.some((t) => t.event === 'trigger_age'))
		const one = rig(); await one.add('solo'); one.clock.t += 120_000
		check('a single entry is written by time', (await one.writer.run()) === 'committed' && one.ch.keysInHead().join() === 'solo')
	}
	{ // both at once, single flight
		const r = rig(); await r.add('m1'); r.clock.t += 120_000; for (const id of ids(9, 'n')) await r.add(id)
		const [a, b] = await Promise.all([r.writer.run(), r.writer.run()])
		check('both conditions and two callers at once: one batch, one pointer', a === 'committed' && b === 'committed' && r.ch.submits.length === 1 && r.ch.uploads === 11)
		check('and nothing further', (await r.writer.run()) === 'idle' && r.ch.submits.length === 1)
	}
	{ // more than 10
		const r = rig(); for (const id of ids(23)) await r.add(id)
		await r.writer.run()
		check('a backlog of 23 goes in one batch with one index and one pointer', r.ch.uploads === 24 && r.ch.submits.length === 1 && r.ch.keysInHead().length === 23)
	}
	{ // leftovers keep their own time
		let late: Promise<unknown> = Promise.resolve()
		const clock = { t: 1_000_000 }
		let r!: ReturnType<typeof rig>
		let added = false
		r = rig({ clock, hooks: { afterPrepare: async () => { if (added) return; added = true; clock.t += 5_000; late = r.add('late'); await late; clock.t += 40_000 } } })
		await r.add('m1'); clock.t += 120_000
		await r.writer.run()
		check('an entry added during a write is not in it', r.ch.keysInHead().join() === 'm1' && (await r.states()).late === 'queued')
		check('and is due 2 minutes after ITS OWN queue time, not after the write', (await r.writer.nextWakeAt()) === 1_000_000 + 120_000 + 5_000 + 120_000, await r.writer.nextWakeAt())
	}
	{ // reload
		const r = rig(); await r.add('m1'); r.clock.t += 500_000
		const again = rig({ store: r.store, chain: r.ch, clock: r.clock })
		check('after a reload an overdue entry is due at once', (await again.writer.nextWakeAt()) === r.clock.t && (await again.writer.run()) === 'committed')
		check('a second mirror of a held entry changes nothing, its queue time included', (await again.add('m1')) === IN_HEAD() && (await again.queue.get('m1'))!.enqueuedAt === 1_000_000)
	}
	{ // failures back off, nothing lost
		const r = rig(); await r.add('m1'); r.clock.t += 120_000; r.ch.fault.upload = true
		check('an upload failure: nothing submitted, entry stays queued', (await r.writer.run()) === 'upload_failed' && r.ch.submits.length === 0 && (await r.states()).m1 === 'queued')
		check('backoff: not retried at once, wake at the backoff time, queue time unchanged', (await r.writer.run(true)) === 'backoff' && (await r.writer.nextWakeAt()) === r.clock.t + batchRetryDelay(1, () => 0.5) && (await r.queue.get('m1'))!.enqueuedAt === 1_000_000)
		r.ch.fault.upload = false; r.clock.t += 30_000
		check('after the backoff it is written once', (await r.writer.run()) === 'committed' && r.ch.keysInHead().join() === 'm1')
	}
	{ // success:false
		const r = rig(); await r.add('m1'); r.clock.t += 120_000; r.ch.fault.answer = 'rejected'
		check('a rejected pointer: not committed, the batch stays in flight', (await r.writer.run()) === 'pointer_rejected' && (await r.states()).m1 === 'queued' && (await r.queue.readFlight()) !== null)
	}
	{ // an ok answer that the head does not show
		const r = rig(); await r.add('m1'); r.clock.t += 120_000; r.ch.fault.answer = 'ok'; r.ch.fault.apply = false
		check('an "ok" the head does not show is not committed', (await r.writer.run()) === 'awaiting_head' && (await r.states()).m1 === 'queued')
	}
	{ // lost confirmation: it had landed
		const r = rig(); await r.add('m1'); r.clock.t += 120_000
		r.ch.fault.answer = 'unknown'; r.ch.fault.apply = false
		await r.writer.run()
		const index = r.ch.submits[0]!.index
		r.ch.head = index; r.ch.nonce += 1 // it lands later; the answer never came
		r.ch.fault = {}; r.clock.t += 61_000
		const uploads = r.ch.uploads
		const again = rig({ store: r.store, chain: r.ch, clock: r.clock })
		check('lost confirmation, head is this batch (after > 60 s and a reload): done, no second submit, no new upload', (await again.writer.run()) === 'committed' && r.ch.submits.length === 1 && r.ch.uploads === uploads && (await again.states()).m1 === IN_HEAD() && r.ch.keysInHead().join() === 'm1')
	}
	{ // lost confirmation: head unchanged
		const r = rig(); await r.add('m1'); r.clock.t += 120_000
		r.ch.fault.answer = 'unknown'; r.ch.fault.apply = false
		await r.writer.run()
		r.ch.nonce += 7 // the account's nonce moved without the head moving
		r.ch.fault = {}; r.clock.t += 61_000; const uploads = r.ch.uploads
		check('lost confirmation, head still the old one: the SAME index is signed with the CURRENT nonce, nothing re-uploaded', (await r.writer.run()) === 'committed' && r.ch.submits.length === 2 && r.ch.submits[1]!.index === r.ch.submits[0]!.index && r.ch.submits[1]!.nonce === '7' && r.ch.uploads === uploads)
	}
	{ // lost confirmation: head is something else
		const r = rig(); await r.add('m1'); r.clock.t += 120_000
		r.ch.fault.answer = 'unknown'; r.ch.fault.apply = false
		await r.writer.run()
		r.ch.other(['theirs']); r.ch.fault = {}; r.clock.t += 61_000
		check('lost confirmation, head is another one: the old batch is dropped and built again on that head', (await r.writer.run()) === 'committed' && r.ch.submits.length === 2 && r.ch.submits[1]!.index !== r.ch.submits[0]!.index && r.ch.keysInHead().join() === 'theirs,m1')
		const s = rig(); await s.add('m1'); s.clock.t += 120_000; s.ch.fault.answer = 'unknown'; s.ch.fault.apply = false
		await s.writer.run()
		s.ch.head = s.ch.submits[0]!.index; s.ch.nonce += 1; s.ch.other(['theirs']); s.ch.fault = {}; s.clock.t += 61_000
		check('another device built ON TOP of this batch: recognised by the keys, not written twice', (await s.writer.run()) === 'committed' && s.ch.submits.length === 1 && s.ch.keysInHead().join() === 'm1,theirs' && (await s.states()).m1 === IN_HEAD())
	}
	{ // head moved between upload and signature
		const clock = { t: 1_000_000 }
		let ch = chain(); let moved = false
		const r = rig({ clock, chain: ch, hooks: { afterPrepare: () => { if (!moved) { moved = true; ch.other(['theirs']) } } } })
		await r.add('m1'); clock.t += 120_000
		check('the head moves after the upload: the stale index is never submitted', (await r.writer.run()) === 'committed' && ch.submits.length === 1 && ch.keysInHead().join() === 'theirs,m1')
		check('a snapshot is read immediately before every submission', ch.log.every((x, i) => x !== 'submit' || ch.log[i - 1] === 'snapshot'), ch.log)
	}
	{ // conflicts
		let ch = chain(); let n = 0
		const r = rig({ chain: ch, hooks: { beforeSubmit: () => { n += 1; ch.other([`theirs${n}`]) } } })
		await r.add('m1'); r.clock.t += 120_000
		check('a pointer race every time: three attempts with the short wait, then backoff; the entry stays', (await r.writer.run()) === 'conflict_exhausted' && ch.submits.length === 3 && r.sleeps.length === 2 && r.sleeps.every((ms) => ms >= 1_000 && ms <= 5_000) && (await r.states()).m1 === 'queued')
	}
	{ // snapshot unreadable
		const r = rig(); await r.add('m1'); r.clock.t += 120_000; r.ch.fault.snapshot = true
		check('head not readable: nothing uploaded or signed', (await r.writer.run()) === 'head_unreadable' && r.ch.uploads === 0 && r.ch.submits.length === 0)
		const s = rig(); await s.add('m1'); s.clock.t += 120_000; s.ch.fault.snapshot = 2
		check('head not readable just before the signature: no signature', (await s.writer.run()) === 'head_unreadable' && s.ch.submits.length === 0)
		const t = rig(); await t.add('m1'); t.clock.t += 120_000; t.ch.fault.loadIndex = true
		check('index of the head not readable: nothing uploaded', (await t.writer.run()) === 'head_unreadable' && t.ch.uploads === 0)
	}
	{ // two tabs
		const store = memory(); const ch = chain(); const clock = { t: 1_000_000 }
		const a = rig({ store, chain: ch, clock }); const b = rig({ store, chain: ch, clock })
		await Promise.all([...ids(6, 'a').map((i) => a.add(i)), ...ids(6, 'b').map((i) => b.add(i))])
		check('two tabs adding at once: no entry is lost', Object.keys(await a.states()).length === 12)
		await Promise.all([a.writer.run(), b.writer.run()])
		for (let i = 0; i < 4; i++) { clock.t += 700_000; await a.writer.run(); await b.writer.run() }
		const keys = ch.keysInHead()
		check('two tabs writing at once: every entry in the head exactly once', keys.length === 12 && new Set(keys).size === 12, keys)
	}
	{ // wallets
		const store = memory(); const ch = chain()
		const a = rig({ store, chain: ch }); const b = rig({ store, chain: chain(), eoa: OTHER, key: KEY2 })
		await a.add('mine'); await b.add('yours')
		check('queues are per wallet', Object.keys(await a.states()).join() === 'mine' && Object.keys(await b.states()).join() === 'yours')
		check('another key opens nothing and says so', (await new ArchiveQueue(store, EOA, KEY2).list()).unreadable === 1 && (await errorOf(new ArchiveQueue(store, EOA, KEY2).get('mine'))) === 'queue_unreadable')
		const text = [...store.map].map(([k, v]) => `${k} ${String(v)}`).join(' ')
		check('no body, record key or peer in clear in any name or document', !text.includes('body of') && !text.includes('mine') && !text.includes(PEER.slice(2)) && !Buffer.from(String([...store.map.values()][0]), 'base64').toString('utf8').includes('body of'))
		const [na] = [...store.map.keys()].filter((k) => k.startsWith(`${BATCH_ENTRY_PREFIX}${EOA}:`))
		store.map.set(`${BATCH_ENTRY_PREFIX}${EOA}:${'0'.repeat(32)}`, store.map.get(na!)!)
		check('a document moved to another name does not open', (await a.queue.list()).unreadable === 1)
	}
	{ // the real adapter swallows failures
		const r = rig(); r.store.fault.swallowSet = true
		check('a store that silently ignores a write: the enqueue FAILS', (await errorOf(r.add('m1'))) === 'queue_write_failed')
		r.store.fault.swallowSet = false; await r.add('m1')
		const sealed = JSON.stringify([...r.store.map])
		r.store.fault.swallowGet = true
		check('a store that answers undefined on a failed read: not "absent", nothing is written over', (await errorOf(r.add('m1'))) === 'queue_unreadable' && JSON.stringify([...r.store.map]) === sealed)
		check('and the queue is not seen as empty', (await r.queue.list()).unreadable === 1)
		r.store.fault.swallowGet = false; r.store.fault.failKeys = true
		check('a listing that fails is an error, not an empty queue', (await r.writer.run()) === 'queue_error' && (await errorOf(r.queue.list())) === 'queue_unreadable')
		check('no key listing in the store: unavailable', (await errorOf(new ArchiveQueue({ get: async () => undefined, set: async () => undefined }, EOA, KEY).enqueue({ peer: PEER, dir: 'in', ts: 1, sendId: 'x', body: 'y' }, 1))) === 'queue_unavailable')
		r.store.fault.failKeys = false
		const name = [...r.store.map.keys()][0]!; r.store.map.set(name, 'damaged')
		check('a damaged document stays byte for byte', (await errorOf(r.add('m1'))) === 'queue_unreadable' && r.store.map.get(name) === 'damaged')
		await r.add('m2'); r.clock.t += 120_000
		check('the other entries are still written; the damaged one is counted, not dropped', (await r.writer.run()) === 'committed' && r.ch.keysInHead().join() === 'm2' && r.store.map.get(name) === 'damaged' && (await r.queue.list()).unreadable === 1)
		const f = rig(); await f.add('m1'); f.clock.t += 120_000; f.store.map.set(`${BATCH_FLIGHT_PREFIX}${EOA}`, 'damaged')
		check('a damaged in-flight record stops the writer (it is not "none in flight")', (await f.writer.run()) === 'queue_error' && f.ch.submits.length === 0)
	}
	{ // pin proof before the pointer
		const r = rig({ pin: false }); await r.add('m1'); r.clock.t += 120_000
		check('no pin interface: NOTHING is signed; the entry stays queued with its body', (await r.writer.run()) === 'not_pinned' && r.ch.submits.length === 0 && r.ch.head === null && (await r.states()).m1 === 'queued' && (await r.queue.get('m1'))!.body === 'body of m1' && r.trace.some((x) => x.event === 'pin_unavailable'))
		check('no pin interface: the next try waits for the backoff (no busy loop)', (await r.writer.nextWakeAt()) === r.clock.t + 30_000)
		const p = rig({ pin: true }); await p.add('m1'); p.clock.t += 120_000
		check('proof not there yet: not signed, the batch stays in flight', (await p.writer.run()) === 'not_pinned' && p.ch.submits.length === 0 && (await p.queue.readFlight()) !== null)
		const flight = (await p.queue.readFlight())!
		const uploads = p.ch.uploads
		p.ch.pinned.add(flight.indexHash); p.clock.t += 30_000
		check('(test double only) proved on the later try: the SAME batch (nothing prepared again) is signed once and archived once', (await p.writer.run()) === 'committed' && p.ch.uploads === uploads && p.ch.submits.length === 1 && p.ch.submits[0]!.index === flight.indexHash && (await p.states()).m1 === 'archived' && p.archived.join() === 'm1' && (await p.queue.get('m1'))!.body === undefined)
		const asked = p.ch.asked[p.ch.asked.length - 1]!
		check('each ask names every fragment of the batch and the index, each with its own random value, new on every ask', asked.length === 2 && new Set(p.ch.asked.flat().map((q) => q.nonce)).size === p.ch.asked.flat().length && asked.every((q) => /^[0-9a-f]{32}$/.test(q.nonce) && q.length > 0))
		check('a proof is not kept for a later try: every try asks again', p.ch.asked.length === 2)
		const timeline = p.trace.map((x) => x.event)
		check('trace order: queued, trigger, objects, proof, pointer, head', timeline.join() === 'queued_first,trigger_age,objects_uploaded,pin_confirmed,pointer_submitted,head_shows_batch', timeline)
		const bad: Array<[string, (r: PinResult, i: number) => PinResult | null]> = [
			['one fragment has no result', (x, i) => (i === 1 ? null : x)],
			['the index has no result', (x, i) => (i === 3 ? null : x)],
			...['accepted', 'pending', 'not_pinned', 'unknown', 'error', 'Pinned'].map((s): [string, (r: PinResult, i: number) => PinResult] => [s, (x, i) => (i === 0 ? { ...x, state: s } : x)]),
			['content not checked', (x, i) => (i === 2 ? { ...x, contentVerified: false } : x)],
			['another length', (x, i) => (i === 0 ? { ...x, length: x.length + 1 } : x)],
			['another random value', (x, i) => (i === 0 ? { ...x, nonce: '0'.repeat(32) } : x)],
		]
		for (const [label, fault] of bad) {
			const q = rig({ pin: true }); for (const id of ['x1', 'x2', 'x3']) await q.add(id); q.clock.t += 120_000
			await q.writer.run()
			q.ch.pinned.add((await q.queue.readFlight())!.indexHash); q.ch.pinFault = fault; q.clock.t += 60_000
			check(`pin gate, ${label}: not signed, nothing confirmed`, (await q.writer.run()) === 'not_pinned' && q.ch.submits.length === 0 && Object.values(await q.states()).join() === 'queued,queued,queued' && q.archived.length === 0)
			q.ch.pinFault = null; q.clock.t += 700_000
			check(`pin gate, ${label}: a later full fresh answer goes through`, (await q.writer.run()) === 'committed' && q.archived.length === 3)
		}
	}
	{ // pin gate edges that do not depend on the way the batch got into the head
		const r = rig({ pin: true }); await r.add('m1'); r.clock.t += 120_000
		await r.writer.run()
		const flight = (await r.queue.readFlight())!
		// the head already shows the batch (a confirmation was lost) and no proof is there yet: in the head, NOT archived
		r.ch.head = flight.indexHash; r.ch.nonce += 1; r.clock.t += 700_000
		await r.writer.run()
		check('in the head without a proof is NOT archived; the body is kept', (await r.states()).m1 === 'committed' && r.archived.length === 0 && (await r.queue.get('m1'))!.body === 'body of m1')
		check('with a way to ask, it is asked again later (no busy loop)', (await r.writer.nextWakeAt()) === r.clock.t + 30_000, await r.writer.nextWakeAt())
		r.ch.pinned.add(flight.indexHash); r.clock.t += 700_000
		await r.writer.run(); await r.writer.run()
		check('(test double only) then proven: archived once, body removed, released once', (await r.states()).m1 === 'archived' && r.archived.join() === 'm1' && (await r.queue.get('m1'))!.body === undefined)
		check('a later mirror of an archived entry says archived', (await r.add('m1')) === 'archived')
		check('trace holds only time, batch number, count and event name', r.trace.every((x) => Object.keys(x).sort().join() === 'at,batch,count,event'))
		check('pin gate: no requests or no results is never covered', !pinCoversAll([], []) && !pinCoversAll([{ hash: 'a', length: 1, nonce: 'n' }], null) && !pinCoversAll([{ hash: 'a', length: 1, nonce: 'n' }], []))
	}
	check('decideFlight', decideFlight('0xA', { baseHead: '0x0', indexHash: '0xa' }) === 'landed' && decideFlight(null, { baseHead: null, indexHash: '0xa' }) === 'submit' && decideFlight('0xB', { baseHead: null, indexHash: '0xa' }) === 'rebuild')
	check('record key: sendId, else a stable content hash', historyRecordKey({ sendId: 's', peer: PEER, dir: 'in', ts: 1, body: 'b' }) === 's' && /^h:[0-9a-f]{32}$/.test(historyRecordKey({ peer: PEER, dir: 'in', ts: 1, body: 'b' })))
	console.log(`history batch queue: ${passes} passed, ${failures} failed`)
	if (failures) process.exit(1)
}
void main()
