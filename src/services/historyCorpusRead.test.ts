/**
 * (reviewer on 2a791a0b): the page's full corpus read, run at run time.
 * - case A: the same device restores or re-imports, and the corpus already exists: the read runs again and its entries are merged;
 * - case B: the mount has no key: the read waits for the key and is not dropped;
 * - : an old client that is still bound to another account feeds nothing; a failed read is retried a bounded number of times, and a
 *   profile update does not start the attempts again; the seen set is cleared only when the account goes empty or changes.
 * The App's merge is injected as `apply`; the chat rebuild itself is tested in historyRestoreApply.test.ts. SYNTHETIC values only.
 */
import {
	CORPUS_READ_MAX_ATTEMPTS,
	CORPUS_READ_RETRY_MS,
	createCorpusReadScheduler,
	type CorpusReadState,
} from './historyCorpusRead'
import type { HistoryEntry } from '@conet.project/chat-sdk'
import { markHistoryEntriesSeen, unseenHistoryEntries } from './historyRestoreSeen'

const ACCOUNT_X = '0x1111111111111111111111111111111111111111'
const ACCOUNT_Y = '0x2222222222222222222222222222222222222222'
const entry = (n: number): HistoryEntry => ({
	seq: n,
	ts: 1762000000000 + n,
	peer: '0x3333333333333333333333333333333333333333',
	dir: 'in',
	sendId: undefined,
	body: `{"text":"synthetic-${n}"}`,
})
const CORPUS = [entry(1), entry(2), entry(3)]
const st = (over: Partial<CorpusReadState> = {}): CorpusReadState => ({ account: ACCOUNT_X, keyReady: true, epoch: 1, ...over })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * A reader the test resolves by hand. `bound` is the account of the active client (the test rebinds it, as a new client would).
 * The applied batches are recorded with their account.
 */
function setup(opts: { maxAttempts?: number; isCurrent?: (a: string) => boolean } = {}) {
	let bound: string | null = ACCOUNT_X
	const reads: Array<{ resolve: (v: HistoryEntry[] | null) => void }> = []
	const applied: Array<{ entries: HistoryEntry[]; account: string }> = []
	const lines: string[] = []
	const retries: Array<{ fn: () => void; ms: number }> = []
	const sched = createCorpusReadScheduler({
		read: () =>
			new Promise<HistoryEntry[] | null>((resolve) => {
				reads.push({ resolve })
			}),
		apply: (entries, account) => applied.push({ entries, account }),
		boundAccount: () => bound,
		isCurrent: opts.isCurrent,
		log: (l) => lines.push(l),
		schedule: (fn, ms) => retries.push({ fn, ms }),
		maxAttempts: opts.maxAttempts,
	})
	return {
		sched,
		reads,
		applied,
		lines,
		retries,
		rebind: (account: string | null) => {
			bound = account
		},
	}
}

describe('when the corpus is read', () => {
	it('mount with an account, a key, a ready worker bound to that account: one read, the entries are applied once', async () => {
		const t = setup()
		t.sched.sync(st())
		expect(t.reads).toHaveLength(1)
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.applied).toEqual([{ entries: CORPUS, account: ACCOUNT_X }])
		expect(t.lines).toEqual(['[history] corpus read reason=mount entries=3'])
	})

	it('repeated syncs with the same state read nothing more (a load or a buffer batch never triggers it)', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.sched.sync(st())
		t.sched.sync(st())
		expect(t.reads).toHaveLength(1)
	})

	it('the account is compared in lower case: a checksummed account reads for a client bound to the lower-case form', () => {
		const t = setup()
		t.sched.sync(st({ account: ACCOUNT_X.toUpperCase().replace('0X', '0x') }))
		expect(t.reads).toHaveLength(1)
	})
})

describe('case B: a mount without a key does not lose the read', () => {
	it('no key at mount: nothing is read; when the key arrives the read runs once and the entries are applied', async () => {
		const t = setup()
		t.sched.sync(st({ keyReady: false }))
		expect(t.reads).toHaveLength(0)
		t.sched.sync(st({ keyReady: true }))
		expect(t.reads).toHaveLength(1)
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.applied).toEqual([{ entries: CORPUS, account: ACCOUNT_X }])
		expect(t.lines[0]).toMatch(/reason=key_ready entries=3/)
	})

	it('no worker client yet (epoch 0): nothing is read; the first ready client reads once', () => {
		const t = setup()
		t.sched.sync(st({ epoch: 0 }))
		expect(t.reads).toHaveLength(0)
		t.sched.sync(st({ epoch: 1 }))
		expect(t.reads).toHaveLength(1)
	})
})

describe('case A: a restore on the same device rebuilds the chats', () => {
	it('the wallet is wiped (no key), the account comes back on the same client: the read runs again', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.sched.sync(st({ account: '', keyReady: false }))
		t.sched.sync(st({ keyReady: true }))
		expect(t.reads).toHaveLength(2)
		t.reads[1].resolve(CORPUS)
		await flush()
		expect(t.applied).toHaveLength(2)
		expect(t.lines[1]).toMatch(/reason=key_ready entries=3/)
	})
})

describe('an old client that is still bound to another account feeds nothing', () => {
	it('the account changed, the old client is still bound to the old account: nothing is read, nothing is applied, nothing is done', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.applied.length = 0
		// The page now holds account Y. The client is still the one for X (it was not stopped).
		t.sched.sync(st({ account: ACCOUNT_Y }))
		expect(t.reads).toHaveLength(1)
		expect(t.applied).toHaveLength(0)
		expect(t.sched.state().doneFor).toBe(`${ACCOUNT_X}#1`)
		expect(t.lines.join('\n')).toMatch(/corpus read waits reason=account_changed: the active client is not bound/)
	})

	it('the account changed and the old client was never bound to the new one: a read that started before the change is dropped', async () => {
		const t = setup()
		t.sched.sync(st())
		t.sched.sync(st({ account: ACCOUNT_Y }))
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.applied).toEqual([])
	})

	it('a new client bound to the new account (a new epoch) reads for the new account; the entries of the new account are applied', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.applied.length = 0
		t.sched.sync(st({ account: ACCOUNT_Y }))
		expect(t.reads).toHaveLength(1)
		t.rebind(ACCOUNT_Y)
		t.sched.sync(st({ account: ACCOUNT_Y, epoch: 2 }))
		expect(t.reads).toHaveLength(2)
		t.reads[1].resolve([entry(9)])
		await flush()
		expect(t.applied).toEqual([{ entries: [entry(9)], account: ACCOUNT_Y }])
		expect(t.lines.join('\n')).toMatch(/corpus read reason=worker_ready entries=1/)
	})

	it('an entry read for X is never applied to Y: the apply callback receives the account of the read', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.applied.every((a) => a.account === ACCOUNT_X)).toBe(true)
	})

	it('a result is not applied when the account is no longer the current one (isCurrent)', async () => {
		let current = ACCOUNT_X
		const t = setup({ isCurrent: (a) => a === current })
		t.sched.sync(st())
		current = ACCOUNT_Y
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.applied).toEqual([])
		expect(t.lines.join('\n')).toMatch(/corpus read dropped reason=mount: the account changed/)
	})

	it('no read and no merge while the client is not bound: the page merge sees nothing of the old account (page-level)', async () => {
		const seen = new Set<string>()
		const merged: number[] = []
		let bound: string | null = ACCOUNT_X
		const reads: Array<{ resolve: (v: HistoryEntry[] | null) => void }> = []
		const sched = createCorpusReadScheduler({
			read: () =>
				new Promise<HistoryEntry[] | null>((resolve) => {
					reads.push({ resolve })
				}),
			apply: (entries, account) => {
				const fresh = unseenHistoryEntries(account, seen, entries)
				markHistoryEntriesSeen(account, seen, fresh)
				merged.push(fresh.length)
			},
			boundAccount: () => bound,
			onReset: () => seen.clear(),
			log: () => undefined,
		})
		// Y is the current account, but the only live client is X's.
		sched.sync(st({ account: ACCOUNT_Y }))
		expect(reads).toHaveLength(0)
		expect(merged).toEqual([])
		expect(seen.size).toBe(0)
		// The client for Y comes up.
		bound = ACCOUNT_Y
		sched.sync(st({ account: ACCOUNT_Y, epoch: 2 }))
		reads[0].resolve(CORPUS)
		await flush()
		expect(merged).toEqual([3])
	})
})

describe('a failed read is retried a bounded number of times, and a profile update does not reset the attempts', () => {
	it('a null read is retried after the delay, and the retry that succeeds is applied', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(null)
		await flush()
		expect(t.retries).toEqual([expect.objectContaining({ ms: 2000 })])
		t.retries[0].fn()
		expect(t.reads).toHaveLength(2)
		t.reads[1].resolve(CORPUS)
		await flush()
		expect(t.applied).toHaveLength(1)
		expect(t.lines.join('\n')).toMatch(/corpus read failed reason=mount attempt=1/)
	})

	it('after maxAttempts failures there is no more retry, and repeated profile updates with the same state start no read', async () => {
		const t = setup({ maxAttempts: 2 })
		t.sched.sync(st())
		t.reads[0].resolve(null)
		await flush()
		t.retries[0].fn()
		t.reads[1].resolve(null)
		await flush()
		expect(t.retries).toHaveLength(1)
		expect(t.reads).toHaveLength(2)
		t.sched.sync(st())
		t.sched.sync(st())
		t.sched.sync(st())
		expect(t.reads).toHaveLength(2)
	})

	it('a key that comes and goes does not restart the attempts of the same account and client', async () => {
		const t = setup({ maxAttempts: 2 })
		t.sched.sync(st())
		t.reads[0].resolve(null)
		await flush()
		t.retries[0].fn()
		t.reads[1].resolve(null)
		await flush()
		t.sched.sync(st({ keyReady: false }))
		t.sched.sync(st({ keyReady: true }))
		t.sched.sync(st())
		expect(t.reads).toHaveLength(2)
	})

	it('a new client (a new epoch) starts the attempts again', async () => {
		const t = setup({ maxAttempts: 2 })
		t.sched.sync(st())
		t.reads[0].resolve(null)
		await flush()
		t.retries[0].fn()
		t.reads[1].resolve(null)
		await flush()
		t.sched.sync(st({ epoch: 2 }))
		expect(t.reads).toHaveLength(3)
	})

	it('a read that throws counts as a failure', () => {
		const sched = createCorpusReadScheduler({
			read: () => {
				throw new Error('synthetic')
			},
			apply: () => undefined,
			boundAccount: () => ACCOUNT_X,
			log: () => undefined,
			schedule: () => undefined,
		})
		expect(() => sched.sync(st())).not.toThrow()
		expect(sched.state().doneFor).toBeNull()
	})

	it('the defaults are the engineering values, exported as named constants', () => {
		expect(CORPUS_READ_RETRY_MS).toBe(2_000)
		expect(CORPUS_READ_MAX_ATTEMPTS).toBe(3)
	})
})

describe('the seen set is cleared only when the account goes empty or changes', () => {
	/** The page's merge in miniature: the seen set decides what is merged (the App uses the same two functions). */
	function page(withReset: boolean) {
		const seen = new Set<string>()
		const merged: number[] = []
		const reads: Array<{ resolve: (v: HistoryEntry[] | null) => void }> = []
		const sched = createCorpusReadScheduler({
			read: () =>
				new Promise<HistoryEntry[] | null>((resolve) => {
					reads.push({ resolve })
				}),
			apply: (entries, account) => {
				const fresh = unseenHistoryEntries(account, seen, entries)
				markHistoryEntriesSeen(account, seen, fresh)
				merged.push(fresh.length)
			},
			boundAccount: () => ACCOUNT_X,
			onReset: withReset ? () => seen.clear() : undefined,
			log: () => undefined,
		})
		return { sched, seen, merged, reads }
	}

	it('a restore of the same account after the account went empty merges all three entries again', async () => {
		const t = page(true)
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.merged).toEqual([3])
		expect(t.seen.size).toBe(3)
		t.sched.sync(st({ account: '', keyReady: false }))
		expect(t.seen.size).toBe(0)
		t.sched.sync(st())
		t.reads[1].resolve(CORPUS)
		await flush()
		expect(t.merged).toEqual([3, 3])
	})

	it('without the reset the same entries are skipped as already seen: this is why the reset exists', async () => {
		const t = page(false)
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.sched.sync(st({ account: '', keyReady: false }))
		t.sched.sync(st())
		t.reads[1].resolve(CORPUS)
		await flush()
		expect(t.merged).toEqual([3, 0])
	})

	it('a key that is briefly missing for the same account does NOT clear the seen set and does NOT repeat the read', async () => {
		const t = page(true)
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		expect(t.seen.size).toBe(3)
		t.sched.sync(st({ keyReady: false }))
		expect(t.seen.size).toBe(3)
		// The key comes back for the same account and client: no repeat of the full read.
		t.sched.sync(st())
		expect(t.reads).toHaveLength(1)
		expect(t.seen.size).toBe(3)
	})

	it('an account change clears the seen set', async () => {
		const t = page(true)
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.sched.sync(st({ account: ACCOUNT_Y }))
		expect(t.seen.size).toBe(0)
	})
})

describe('the log carries numbers and reasons only', () => {
	it('no address appears in any line, including the waiting line', async () => {
		const t = setup()
		t.sched.sync(st())
		t.reads[0].resolve(CORPUS)
		await flush()
		t.sched.sync(st({ account: ACCOUNT_Y }))
		t.sched.sync(st({ account: '', keyReady: false }))
		expect(t.lines.join('\n')).not.toMatch(/0x[0-9a-fA-F]{40}/)
		expect(t.lines.join('\n')).not.toContain(ACCOUNT_X)
	})
})
