/**
 * the history restore rebuilds the page's chats, run at run time.
 *
 * The page is a small harness: its state is a profile (chats and phone calls), the account and the key, and its apply path mirrors the App's
 * chain (planRestoreBatch, then mergeRestoreIntoProfile as the setProfiles update). The scheduler is the real one (historyCorpusRead.ts).
 * The read is a fake that returns the corpus. Cases:
 * - (a) the SDK corpus is already there and the page's chats are empty: a restore on the same device (wipe, then re-import of the same
 *   account, no page reload) rebuilds the chats and the phone calls;
 * - (b) the mount has no key, the key comes later: the entries are merged once the key is there;
 * - (c) : an old client still bound to another account: nothing is read, and the new account's chats are not touched;
 * - (d) : an empty owner skips nothing and marks nothing;
 * - (e) cancellation and nothing-to-do return no plan; a merge with nothing new changes nothing.
 * SYNTHETIC values only.
 */
jest.mock('./chatWorkerBridge', () => ({ appendWorkerHistory: jest.fn() }))
// voiceCallSession (the call record merge) imports the beamio tag bridge through the alias; the same stub the voice tests use.
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })

import type { HistoryEntry } from '@conet.project/chat-sdk'
import { planRestoreBatch, mergeRestoreIntoProfile, createHistoryApplier, commitRestorePlan, markRestorePlanSeen } from './historyRestoreApply'
import { createCorpusReadScheduler, type CorpusReadState } from './historyCorpusRead'

const X = '0x1111111111111111111111111111111111111111'
const Y = '0x2222222222222222222222222222222222222222'
const P1 = '0x3333333333333333333333333333333333333333'
const P2 = '0x4444444444444444444444444444444444444444'
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const msg = (peer: string, n: number, text: string, from: 'me' | 'them' = 'them'): HistoryEntry => ({
	seq: n,
	ts: 1762000000000 + n,
	peer,
	dir: from === 'them' ? 'in' : 'out',
	sendId: undefined,
	body: JSON.stringify({ id: `m-${peer.slice(0, 6)}-${n}`, from, text, createdAt: 1762000000000 + n, status: 'sent' }),
})
const callEntry = (peer: string, n: number): HistoryEntry => ({
	seq: n,
	ts: 1762000000000 + n,
	peer,
	dir: 'in',
	sendId: undefined,
	body: JSON.stringify({
		id: `call-${n}`,
		from: 'them',
		text: '',
		createdAt: 1762000000000 + n,
		status: 'sent',
		callRecord: {
			callId: `call-id-${n}`,
			sessionId: `sess-${n}`,
			peerAddress: peer,
			direction: 'incoming',
			status: 'missed',
			createdAt: 1762000000000 + n,
		},
	}),
})

/** The corpus the SDK still holds for an account: two peers with messages, and one call. */
const CORPUS_X: HistoryEntry[] = [msg(P1, 1, 'hi'), msg(P1, 2, 'again', 'me'), msg(P2, 3, 'hello'), callEntry(P2, 4)]

type Profile = { privateKeyArmor?: string; keyID?: string; chats: Array<Record<string, unknown>>; phoneCalls: Array<Record<string, unknown>> }

/** The page: its state, and the apply path of the App (planRestoreBatch, then the merge as the setProfiles update). */
function page(opts: { profile: Profile | null; account: string; keyReady: boolean; bound: string | null }) {
	const st = {
		profile: opts.profile,
		account: opts.account,
		keyReady: opts.keyReady,
		bound: opts.bound,
		seen: new Set<string>(),
		stubs: [] as string[],
		logs: [] as string[],
	}
	const reads: Array<(v: HistoryEntry[] | null) => void> = []
	const createStub = async (peer: string) => {
		st.stubs.push(peer)
		return { address: peer, messages: [], beamio: {}, chatData: {} } as unknown as chatData
	}
	const applyEntries = async (entries: HistoryEntry[], account: string) => {
		if (account !== st.account || !st.profile) return
		const profile0 = st.profile
		const existingPeers = new Set(profile0.chats.map((c) => String(c.address || '').toLowerCase()))
		const plan = await planRestoreBatch({
			entries,
			owner: account,
			seen: st.seen,
			existingPeers,
			createStub,
			isCancelled: () => false,
		})
		if (!plan) return
		const result = commitRestorePlan([st.profile as unknown as profile], plan, st.account, st.seen)
		st.logs.push(...result.logs.map((l) => l.message))
		if (result.changed) st.profile = result.list[0] as unknown as Profile
	}
	const sched = createCorpusReadScheduler({
		read: () =>
			new Promise<HistoryEntry[] | null>((resolve) => {
				reads.push(resolve)
			}),
		apply: (entries, account) => {
			void applyEntries(entries, account)
		},
		boundAccount: () => st.bound,
		isCurrent: (a) => a === st.account,
		onReset: () => st.seen.clear(),
		log: () => undefined,
	})
	const state = (over: Partial<CorpusReadState> = {}): CorpusReadState => ({
		account: st.account,
		keyReady: st.keyReady,
		epoch: 1,
		...over,
	})
	return { st, sched, reads, state, applyEntries }
}

const emptyProfile = (keyID = X): Profile => ({ privateKeyArmor: 'synthetic-armor', keyID, chats: [], phoneCalls: [] })

describe('(a) the same device restores: the chats are rebuilt from the corpus that is already there', () => {
	it('the page chats are empty after the wipe and the re-import; the corpus rebuilds them, with the phone call', async () => {
		const p = page({ profile: emptyProfile(), account: X, keyReady: true, bound: X })
		// The first mount: the corpus is read and the chats are built.
		p.sched.sync(p.state())
		p.reads[0](CORPUS_X)
		await flush()
		// Each new peer's chat is put at the top, in the order of the entries: P1 first, then P2 above it.
		expect(p.st.profile?.chats.map((c) => c.address)).toEqual([P2, P1])
		expect(p.st.profile?.phoneCalls).toHaveLength(1)

		// The passcode reset clears the wallet and the chats; the re-import brings the same account back, no page reload.
		p.st.profile = null
		p.st.account = ''
		p.st.keyReady = false
		p.sched.sync(p.state())
		p.st.profile = emptyProfile()
		p.st.account = X
		p.st.keyReady = true
		p.sched.sync(p.state())
		expect(p.reads).toHaveLength(2)
		p.reads[1](CORPUS_X)
		await flush()

		// The chats are rebuilt: two peers, their messages in order, unread counts at zero, and the call record.
		expect(p.st.profile?.chats.map((c) => c.address)).toEqual([P2, P1])
		const p1 = p.st.profile?.chats.find((c) => c.address === P1) as { messages: Array<{ text: string }>; unreadCount: number }
		expect(p1.messages.map((m) => m.text)).toEqual(['hi', 'again'])
		expect(p1.unreadCount).toBe(0)
		expect(p.st.profile?.phoneCalls).toHaveLength(1)
		// One stub per peer for the first mount and one for the restore.
		expect(p.st.stubs).toEqual([P1, P2, P1, P2])
	})

	it('without the reset the same entries would be skipped (the seen set holds them): the rebuild needs the reset of the account', async () => {
		const p = page({ profile: emptyProfile(), account: X, keyReady: true, bound: X })
		p.sched.sync(p.state())
		p.reads[0](CORPUS_X)
		await flush()
		// The chats are emptied, but the seen set still holds the keys (no reset): a read for the same account merges nothing.
		p.st.profile = emptyProfile()
		// A new client for the same account (a new epoch) reads again; the seen set still holds the keys, so nothing is merged.
		p.sched.sync(p.state({ epoch: 2 }))
		p.reads[1](CORPUS_X)
		await flush()
		expect(p.st.profile?.chats).toEqual([])
	})
})

describe('(b) the mount has no key: the entries are merged once the key is there', () => {
	it('no key at mount, nothing is read; the key arrives, the corpus is read and the chats are built', async () => {
		const p = page({ profile: emptyProfile(), account: X, keyReady: false, bound: X })
		p.sched.sync(p.state())
		expect(p.reads).toHaveLength(0)
		p.st.keyReady = true
		p.sched.sync(p.state())
		expect(p.reads).toHaveLength(1)
		p.reads[0](CORPUS_X)
		await flush()
		expect(p.st.profile?.chats.map((c) => c.address)).toEqual([P2, P1])
	})
})

describe('(c) : an old client still bound to another account does not feed the new account', () => {
	it('the page is on Y, the only live client is X: no read, and Y chats are not touched', async () => {
		const p = page({ profile: emptyProfile(Y), account: Y, keyReady: true, bound: X })
		p.sched.sync(p.state())
		expect(p.reads).toHaveLength(0)
		expect(p.st.profile?.chats).toEqual([])
		// The client for Y comes up: now the corpus of Y is read and applied to Y.
		p.st.bound = Y
		p.sched.sync(p.state({ epoch: 2 }))
		expect(p.reads).toHaveLength(1)
		p.reads[0]([msg(P1, 1, 'for y')])
		await flush()
		expect(p.st.profile?.chats.map((c) => c.address)).toEqual([P1])
	})
})

describe('(d) : an empty owner skips nothing and marks nothing', () => {
	it('with no owner the same entries are planned again and again, and the seen set stays empty', async () => {
		const seen = new Set<string>()
		const make = (owner: string) =>
			planRestoreBatch({
				entries: [msg(P1, 1, 'hi')],
				owner,
				seen,
				existingPeers: new Set([P1]),
				createStub: async () => ({}) as chatData,
				isCancelled: () => false,
			})
		expect(await make('')).not.toBeNull()
		expect(await make('')).not.toBeNull()
		expect(seen.size).toBe(0)
		// Once the owner is known, the batch is merged and marked.
		const planned = await make(X)
		expect(planned).not.toBeNull()
		expect(seen.size).toBe(0)
		// Marked once the plan is committed.
		markRestorePlanSeen(planned!, seen)
		expect(seen.size).toBe(1)
		expect(await make(X)).toBeNull()
	})
})

describe('(e) nothing to do, cancellation, and a merge with nothing new', () => {
	it('a batch with only invalid peers plans nothing', async () => {
		const plan = await planRestoreBatch({
			entries: [msg('all', 1, 'x'), { ...msg(P1, 2, 'y'), peer: 'not-an-address' }],
			owner: X,
			seen: new Set(),
			existingPeers: new Set(),
			createStub: async () => ({}) as chatData,
			isCancelled: () => false,
		})
		expect(plan).toBeNull()
	})

	it('a cancelled run creates no stub and marks nothing', async () => {
		const seen = new Set<string>()
		const stubs: string[] = []
		const plan = await planRestoreBatch({
			entries: [msg(P1, 1, 'x')],
			owner: X,
			seen,
			existingPeers: new Set(),
			createStub: async (peer) => {
				stubs.push(peer)
				return {} as chatData
			},
			isCancelled: () => true,
		})
		expect(plan).toBeNull()
		expect(stubs).toEqual([])
		expect(seen.size).toBe(0)
	})

	it('a merge of entries the chat already has changes nothing and returns the same profile object', async () => {
		const seen = new Set<string>()
		const first = await planRestoreBatch({
			entries: [msg(P1, 1, 'hi')],
			owner: X,
			seen: new Set(),
			existingPeers: new Set(),
			createStub: async (peer) => ({ address: peer, messages: [], beamio: {}, chatData: {} }) as unknown as chatData,
			isCancelled: () => false,
		})
		expect(first).not.toBeNull()
		const profileNow = { chats: [], phoneCalls: [] } as unknown as profile
		const once = mergeRestoreIntoProfile(profileNow, first!)
		expect(once.changed).toBe(true)
		// The same entries again, as a fresh plan (no seen set): the chat already has the message, so nothing changes.
		const again = await planRestoreBatch({
			entries: [msg(P1, 1, 'hi')],
			owner: X,
			seen,
			existingPeers: new Set([P1]),
			createStub: async () => ({}) as chatData,
			isCancelled: () => false,
		})
		const twice = mergeRestoreIntoProfile(once.profile!, again!)
		expect(twice.changed).toBe(false)
		expect(twice.profile).toBe(once.profile)
	})
})

describe('(f) (reviewer blocker A): a queued batch belongs to the account it was queued for', () => {
	const PK_X = 'synthetic-armor-x'
	const PK_Y = 'synthetic-armor-y'
	/** The page: the account and the key change in the test, as a re-import or a restore would. */
	function harness() {
		const st = { account: X, key: PK_X }
		const seen = new Set<string>()
		const stubCalls: string[] = []
		const commits: number[] = []
		const logs: string[] = []
		let releaseFirstStub: () => void = () => undefined
		const firstStubGate = new Promise<void>((r) => {
			releaseFirstStub = () => r()
		})
		const applier = createHistoryApplier({
			accountNow: () => st.account,
			keyNow: () => st.key,
			accountOfKey: (pk) => (pk === PK_X ? X : pk === PK_Y ? Y : ''),
			seen,
			isCancelled: () => false,
			existingPeersNow: () => new Set<string>(),
			createStubFor: async (_pk, peer) => {
				stubCalls.push(peer)
				// The first stub of the first batch waits: a batch in front is blocked.
				if (stubCalls.length === 1) await firstStubGate
				return { address: peer, messages: [], beamio: {}, chatData: {} } as unknown as chatData
			},
			commit: (plan) => {
				commits.push(plan.byPeer.size)
				const r = commitRestorePlan([{ chats: [], phoneCalls: [] } as unknown as profile], plan, st.account, seen)
				return { changed: r.changed }
			},
			afterCommit: async () => undefined,
			log: (l) => logs.push(l),
		})
		return { st, seen, stubCalls, commits, logs, applier, releaseFirstStub: () => releaseFirstStub() }
	}

	it('a batch queued for X, behind a blocked batch, does not run for Y: no stub, no merge, no mark', async () => {
		const t = harness()
		t.applier.enqueue([msg(P1, 1, 'first')]) // X: its first stub waits
		t.applier.enqueue([msg(P2, 2, 'queued for x')]) // X: queued behind it
		// Let the first batch start and block on its stub, then the page switches to account Y (a new key).
		await new Promise((r) => setTimeout(r, 0))
		expect(t.stubCalls).toEqual([P1])
		t.st.account = Y
		t.st.key = PK_Y
		t.releaseFirstStub()
		await t.applier.idle()
		// Only the first batch asked for a stub, and before the switch: the queued one never did.
		expect(t.stubCalls).toEqual([P1])
		expect(t.commits).toEqual([])
		expect(t.seen.size).toBe(0)
		expect(t.logs.join('\n')).toMatch(/batch dropped: the account changed before it ran/)
	})

	it('a batch queued for X runs for X when X is still the account, and merges and marks', async () => {
		const t = harness()
		t.applier.enqueue([msg(P1, 1, 'hi')])
		t.releaseFirstStub()
		await t.applier.idle()
		expect(t.stubCalls).toEqual([P1])
		expect(t.commits).toEqual([1])
		expect(t.seen.size).toBe(1)
	})

	it('a key that is not the key of the queued account is refused before any stub', async () => {
		const t = harness()
		t.st.key = PK_Y // the account is still X, but the key belongs to Y
		t.applier.enqueue([msg(P1, 1, 'hi')])
		t.releaseFirstStub()
		await t.applier.idle()
		expect(t.stubCalls).toEqual([])
		expect(t.commits).toEqual([])
		expect(t.seen.size).toBe(0)
	})

	it('with no account at queue time nothing is queued at all', async () => {
		const t = harness()
		t.st.account = ''
		t.applier.enqueue([msg(P1, 1, 'hi')])
		await t.applier.idle()
		expect(t.stubCalls).toEqual([])
		expect(t.logs.join('\n')).toMatch(/batch not queued: no account/)
	})

	it('a failing batch does not stop the batches queued after it', async () => {
		const logs: string[] = []
		const commitsTried: number[] = []
		const failing = createHistoryApplier({
			accountNow: () => X,
			keyNow: () => PK_X,
			accountOfKey: () => X,
			seen: new Set(),
			isCancelled: () => false,
			existingPeersNow: () => new Set<string>(),
			createStubFor: async (_pk, peer) => ({ address: peer, messages: [], beamio: {}, chatData: {} }) as unknown as chatData,
			commit: (plan) => {
				commitsTried.push(plan.byPeer.size)
				if (commitsTried.length === 1) throw new Error('synthetic')
				return { changed: true }
			},
			afterCommit: async () => undefined,
			log: (l) => logs.push(l),
		})
		failing.enqueue([msg(P1, 1, 'a')])
		failing.enqueue([msg(P2, 2, 'b')])
		await failing.idle()
		expect(logs.join('\n')).toMatch(/batch failed: synthetic/)
		// The second batch still ran its commit.
		expect(commitsTried).toEqual([1, 1])
	})
})

describe('(g) : a plan is marked as merged only when it is committed for the page account', () => {
	it('a committed plan for an account that is no longer the page account marks nothing and merges nothing', async () => {
		const seen = new Set<string>()
		const plan = await planRestoreBatch({
			entries: [msg(P1, 1, 'hi')],
			owner: X,
			seen,
			existingPeers: new Set([P1]),
			createStub: async () => ({}) as chatData,
			isCancelled: () => false,
		})
		expect(seen.size).toBe(0)
		const list = [{ chats: [{ address: P1, messages: [] }], phoneCalls: [] } as unknown as profile]
		const result = commitRestorePlan(list, plan!, Y, seen)
		expect(result.changed).toBe(false)
		expect(result.list).toBe(list)
		expect(seen.size).toBe(0)
	})

	it('after the page went to another account and back, the entries still merge: nothing was marked for the dropped batch', async () => {
		const seen = new Set<string>()
		const make = () =>
			planRestoreBatch({
				entries: [msg(P1, 1, 'hi')],
				owner: X,
				seen,
				existingPeers: new Set([P1]),
				createStub: async () => ({}) as chatData,
				isCancelled: () => false,
			})
		const list = [{ chats: [{ address: P1, messages: [] }], phoneCalls: [] } as unknown as profile]
		// The batch is planned for X, but the page is on Y when it commits: dropped, nothing marked.
		const dropped = await make()
		expect(commitRestorePlan(list, dropped!, Y, seen).changed).toBe(false)
		expect(seen.size).toBe(0)
		// The page is back on X: the same entries merge now.
		const again = await make()
		const merged = commitRestorePlan(list, again!, X, seen)
		expect(merged.changed).toBe(true)
		expect(seen.size).toBe(1)
	})

	it('a commit for the page account marks the mergeable entries, so a repeat of them is not planned again', async () => {
		const seen = new Set<string>()
		const plan = await planRestoreBatch({
			entries: [msg(P1, 1, 'hi'), msg(P2, 2, 'other peer, no chat')],
			owner: X,
			seen,
			existingPeers: new Set([P1]),
			createStub: async () => {
				throw new Error('no stub for this peer')
			},
			isCancelled: () => false,
		})
		commitRestorePlan([{ chats: [{ address: P1, messages: [] }], phoneCalls: [] } as unknown as profile], plan!, X, seen)
		// Only the entry of the peer that has a chat is marked; the other peer's entry is still to be merged later.
		expect(seen.size).toBe(1)
	})
})

