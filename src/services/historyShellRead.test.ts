/**
 * @jest-environment node
 *
 * The shell's full history read (no page key): it runs by events, a failed or empty read is retried on the cold-start backoff, a late native init
 * is picked up, the batch account is checked against the native identity's EOA, a batch for another account is dropped, and a merge keeps the
 * stored row's verified fingerprint. SYNTHETIC values only.
 */
import type { HistoryEntry } from '@conet.project/chat-sdk'

jest.mock('./chatWorkerBridge', () => ({ appendWorkerHistory: jest.fn() }))
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
import { createCorpusReadScheduler, type CorpusReadState, type CorpusReadStatus } from './historyCorpusRead'
import { createColdStartBackoff, COLD_START_WINDOW_MS } from './coldStartBackoff'
import { commitRestorePlan, createHistoryApplier, mergeRestoreIntoProfile } from './historyRestoreApply'

const X = '0x1111111111111111111111111111111111111111'
const Y = '0x2222222222222222222222222222222222222222'
const PEER = '0x3333333333333333333333333333333333333333'
const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const entry = (n: number, peer = PEER): HistoryEntry => ({
	seq: n,
	ts: 1762000000000 + n,
	peer,
	dir: 'in',
	sendId: undefined,
	body: JSON.stringify({ id: `m-${n}`, from: 'them', text: `synthetic-${n}`, createdAt: 1762000000000 + n, status: 'sent' }),
})
const st = (over: Partial<CorpusReadState> = {}): CorpusReadState => ({ account: X, keyReady: true, epoch: 1, ...over })

function shellScheduler(reads: Array<HistoryEntry[] | null>) {
	let t = 1_000_000
	const timers: Array<{ fn: () => void; ms: number }> = []
	const statuses: CorpusReadStatus[] = []
	const applied: HistoryEntry[][] = []
	const read = jest.fn(async () => (reads.length > 1 ? (reads.shift() as HistoryEntry[] | null) : reads[0]))
	const s = createCorpusReadScheduler({
		read,
		apply: (e) => void applied.push(e),
		boundAccount: () => X,
		backoff: createColdStartBackoff(() => t),
		onStatus: (v) => void statuses.push(v),
		schedule: (fn, ms) => void timers.push({ fn, ms }),
	})
	const fire = async () => {
		const next = timers.shift()
		if (!next) return false
		t += next.ms
		next.fn()
		await flush()
		return true
	}
	return { s, read, timers, statuses, applied, fire, advance: (ms: number) => void (t += ms) }
}

describe('the read is not final while the client has just become ready', () => {
	it('an empty read is retried on the backoff and the entries that arrive later are merged; the list is "loading" until then', async () => {
		const h = shellScheduler([[], [], CORPUS(3)])
		h.s.sync(st())
		await flush()
		expect(h.statuses).toEqual(['loading'])
		expect(h.applied).toHaveLength(0)
		expect(h.timers.map((x) => x.ms)).toEqual([1000])
		await h.fire()
		expect(h.timers.map((x) => x.ms)).toEqual([2000])
		await h.fire()
		expect(h.applied).toHaveLength(1)
		expect(h.applied[0]).toHaveLength(3)
		expect(h.statuses[h.statuses.length - 1]).toBe('settled')
		expect(h.read).toHaveBeenCalledTimes(3)
	})
	it('a failed (null) read is retried the same way', async () => {
		const h = shellScheduler([null, CORPUS(2)])
		h.s.sync(st())
		await flush()
		await h.fire()
		expect(h.applied).toHaveLength(1)
		expect(h.statuses[h.statuses.length - 1]).toBe('settled')
	})
	it('no attempt-count stop: more than three failures are still retried inside the window', async () => {
		const h = shellScheduler([null])
		h.s.sync(st())
		await flush()
		for (let i = 0; i < 5; i++) await h.fire()
		expect(h.read.mock.calls.length).toBeGreaterThan(3)
		expect(h.statuses).not.toContain('settled')
	})
	it('the window used up settles it empty: then (and only then) the list may say "No conversations yet"', async () => {
		const h = shellScheduler([[]])
		h.s.sync(st())
		await flush()
		let guard = 0
		while ((await h.fire()) && guard++ < 50) {
			/* run every scheduled retry */
		}
		expect(h.statuses[h.statuses.length - 1]).toBe('settled')
		expect(h.applied).toHaveLength(0)
		expect(h.timers).toHaveLength(0)
		void COLD_START_WINDOW_MS
	})
})

describe('an account with no conversations does not spin for the whole window', () => {
	it('three answered reads with no entries settle the list as empty; the reads go on and a later row is still applied', async () => {
		const h = shellScheduler([[], [], [], CORPUS(2)])
		h.s.sync(st())
		await flush()
		expect(h.statuses).not.toContain('settled')
		await h.fire()
		expect(h.statuses).not.toContain('settled')
		await h.fire()
		expect(h.statuses[h.statuses.length - 1]).toBe('settled')
		expect(h.timers.length).toBeGreaterThan(0) // the reads continue
		await h.fire()
		expect(h.applied).toHaveLength(1)
		expect(h.statuses[h.statuses.length - 1]).toBe('settled')
	})
})

function CORPUS(n: number): HistoryEntry[] {
	return Array.from({ length: n }, (_, i) => entry(i + 1))
}

describe('a native init that is later than the page backoff window: events pick the read up', () => {
	it('before the client is ready nothing is read and the list is loading; the epoch event (init done) starts the read; a chat-started event reads once more', async () => {
		const h = shellScheduler([CORPUS(2)])
		h.s.sync(st({ keyReady: false, epoch: 0 }))
		h.advance(130_000) // the native init takes 130 s: far past the 60 s page window; no read, no timer
		h.s.sync(st({ keyReady: false, epoch: 0 }))
		expect(h.read).not.toHaveBeenCalled()
		expect(h.statuses.every((s) => s === 'loading')).toBe(true)
		h.s.sync(st({ keyReady: true, epoch: 1 })) // init done: the account is bound and the client ready
		await flush()
		expect(h.read).toHaveBeenCalledTimes(1)
		expect(h.applied).toHaveLength(1)
		h.s.sync(st({ keyReady: true, epoch: 2 })) // the chat started: epoch + started tick
		await flush()
		expect(h.read).toHaveBeenCalledTimes(2)
	})
})

describe('the batch account in a shell is the native identity EOA', () => {
	function harness(nativeEoa: () => string) {
		const seen = new Set<string>()
		const logs: string[] = []
		const commits: number[] = []
		const st = { account: X }
		const applier = createHistoryApplier({
			accountNow: () => st.account,
			keyNow: () => '',
			accountOfKey: () => '',
			shellAccountCheck: (account) => nativeEoa().toLowerCase() === account,
			seen,
			isCancelled: () => false,
			existingPeersNow: () => new Set<string>(),
			createStubFor: async (_pk, peer) => ({ address: peer, messages: [], beamio: {}, chatData: {} }) as never,
			commit: (plan) => {
				commits.push(plan.byPeer.size)
				const r = commitRestorePlan([{ chats: [], phoneCalls: [] } as never], plan, st.account, seen)
				return { changed: r.changed }
			},
			afterCommit: async () => undefined,
			log: (l) => void logs.push(l),
		})
		return { applier, seen, logs, commits, st }
	}
	it('a batch for the native account merges, with no page key at all', async () => {
		const t = harness(() => X)
		t.applier.enqueue([entry(1)])
		await t.applier.idle()
		expect(t.commits).toEqual([1])
		expect(t.seen.size).toBeGreaterThan(0)
	})
	it('negative: a batch for another account than the native identity is dropped: no stub, no merge, nothing marked', async () => {
		const t = harness(() => Y) // the page's account is X, the native identity is Y
		t.applier.enqueue([entry(1)])
		await t.applier.idle()
		expect(t.commits).toEqual([])
		expect(t.seen.size).toBe(0)
		expect(t.logs.join('\n')).toMatch(/not the native identity/)
	})
	it('negative: the native identity not known yet (empty): dropped', async () => {
		const t = harness(() => '')
		t.applier.enqueue([entry(1)])
		await t.applier.idle()
		expect(t.commits).toEqual([])
	})
	it('negative: the account switches to another one while the batch waits: still dropped (the queued account must still be current)', async () => {
		const t = harness(() => X)
		t.applier.enqueue([entry(1)])
		t.st.account = Y
		await t.applier.idle()
		expect(t.commits).toEqual([])
	})
})

describe('a merge keeps the stored row', () => {
	it('an existing row keeps its verified fingerprint and key fields; only the messages and counters change', () => {
		const row = {
			address: PEER,
			beamio: {},
			messages: [],
			chatData: { publicArmored: 'PUB', routersArmoreds: 'ROUTE', verifiedFingerprint: 'AB12CD34', keyFingerprint: 'AB12CD34' },
		}
		const plan = { owner: X, byPeer: new Map([[PEER, [entry(1), entry(2)]]]), stubs: new Map() } as never
		const merged = mergeRestoreIntoProfile({ chats: [row], phoneCalls: [] } as never, plan)
		const out = (merged.profile as unknown as { chats: Array<typeof row & { messages: unknown[] }> }).chats[0]
		expect(out.chatData.verifiedFingerprint).toBe('AB12CD34')
		expect(out.chatData.keyFingerprint).toBe('AB12CD34')
		expect(out.chatData.publicArmored).toBe('PUB')
		expect(out.messages.length).toBe(2)
	})
})
