/**
 * a shell profile update that could not reach the server is queued, persisted, re-sent from the latest local
 * state with a backoff, and shown as pending or failed. Only an explicit server refusal counts as a failure; waiting (no key,
 * network, transient server answer) never does. Generations are never reused. The queue keeps only addresses (no key, no body).
 */
import {
	PENDING_SERVER_SYNC_EVENT,
	PENDING_SERVER_SYNC_INTERVAL_MS,
	PENDING_SERVER_SYNC_KEY,
	PENDING_SERVER_SYNC_MAX_FAILURES,
	completePendingServerSync,
	enqueuePendingServerSync,
	ensurePendingServerSync,
	flushPendingServerSync,
	pendingServerSyncGeneration,
	pendingServerSyncItems,
	pendingServerSyncNoticeVisible,
	pendingServerSyncStatus,
	profileSyncPending,
	registerPendingSender,
	resetPendingServerSyncForTest,
} from './pendingServerSync'
import { RETRY_BACKOFF_CAP_MS, backoffDelayMs } from './retryBackoff'

const A = '0x1563915e194D8CfBA1943570603F7606A3115508'
const B = '0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB'
const HOUR = 60 * 60_000

/** Each flush runs an hour after the last one, which is later than any backoff step, so every queued item is due. */
let clock = 1_000_000_000
const later = (): number => (clock += HOUR)

beforeEach(() => {
	window.localStorage.clear()
	resetPendingServerSyncForTest()
	clock = 1_000_000_000
})

describe('pending server sync queue', () => {
	it('an enqueued account persists (lower-case address) and is still there after a restart (module reload)', () => {
		enqueuePendingServerSync(A, 1000)
		expect(window.localStorage.getItem(PENDING_SERVER_SYNC_KEY)).not.toBeNull()
		let reloaded: typeof import('./pendingServerSync') | null = null
		jest.isolateModules(() => {
			reloaded = require('./pendingServerSync')
		})
		expect(reloaded!.pendingServerSyncItems()).toEqual([{ eoa: A.toLowerCase(), queuedAt: 1000, failures: 0, gen: 1, attempts: 0, nextAt: 0 }])
		expect(reloaded!.pendingServerSyncStatus(A)).toBe('pending')
	})

	it('the queue keeps only the address and the schedule: no private key, no request body, no profile data', () => {
		enqueuePendingServerSync(A)
		const stored = JSON.parse(window.localStorage.getItem(PENDING_SERVER_SYNC_KEY) as string)
		expect(Object.keys(stored[0]).sort()).toEqual(['attempts', 'eoa', 'failures', 'gen', 'nextAt', 'queuedAt'])
		expect(window.localStorage.getItem(PENDING_SERVER_SYNC_KEY)).not.toMatch(/privateKey|accountName|beamio/)
	})

	it('a save of an existing item is a new intent: one item, and its failure count starts again', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async () => 'failed', later())
		enqueuePendingServerSync(A)
		expect(pendingServerSyncItems()).toHaveLength(1)
		expect(pendingServerSyncItems()[0].failures).toBe(0)
	})

	it('a re-send from the queue keeps the item and its count; it adds the item only when it is missing', async () => {
		ensurePendingServerSync(A)
		await flushPendingServerSync(async () => 'failed', later())
		ensurePendingServerSync(A)
		expect(pendingServerSyncItems()).toHaveLength(1)
		expect(pendingServerSyncItems()[0].failures).toBe(1)
	})

	it('an item at MAX_FAILURES is not retried by the queue; a new save retries it from zero', async () => {
		enqueuePendingServerSync(A)
		for (let i = 0; i < PENDING_SERVER_SYNC_MAX_FAILURES; i++) await flushPendingServerSync(async () => 'failed', later())
		expect(pendingServerSyncStatus(A)).toBe('failed')
		let calls = 0
		await flushPendingServerSync(async () => {
			calls++
			return 'sent'
		}, later())
		expect(calls).toBe(0)
		enqueuePendingServerSync(A)
		expect(pendingServerSyncStatus(A)).toBe('pending')
		expect(pendingServerSyncItems()[0].failures).toBe(0)
		const send = jest.fn(async () => 'sent' as const)
		await flushPendingServerSync(send, later())
		expect(send).toHaveBeenCalledTimes(1)
		expect(pendingServerSyncItems()).toEqual([])
	})

	it('a sent outcome removes the item; a deferred outcome keeps it without counting a failure; a failed outcome counts one', async () => {
		enqueuePendingServerSync(A)
		enqueuePendingServerSync(B)
		await flushPendingServerSync(async (eoa) => (eoa === A.toLowerCase() ? 'sent' : 'deferred'), later())
		expect(pendingServerSyncItems().map((i) => i.eoa)).toEqual([B.toLowerCase()])
		expect(pendingServerSyncItems()[0].failures).toBe(0)
		await flushPendingServerSync(async () => 'failed', later())
		expect(pendingServerSyncItems()[0].failures).toBe(1)
	})

	it('the sender gets the address only; the re-send is built by the sender from the latest local state', async () => {
		enqueuePendingServerSync(A)
		const seen: string[] = []
		await flushPendingServerSync(async (eoa) => {
			seen.push(eoa)
			return 'sent'
		}, later())
		expect(seen).toEqual([A.toLowerCase()])
		expect(pendingServerSyncItems()).toEqual([])
	})

	it('after MAX_FAILURES explicit refusals the item is failed: visible, kept, and no longer retried', async () => {
		enqueuePendingServerSync(A)
		for (let i = 0; i < PENDING_SERVER_SYNC_MAX_FAILURES; i++) await flushPendingServerSync(async () => 'failed', later())
		expect(pendingServerSyncStatus(A)).toBe('failed')
		let calls = 0
		await flushPendingServerSync(async () => {
			calls++
			return 'sent'
		}, later())
		expect(calls).toBe(0)
		expect(pendingServerSyncItems()).toHaveLength(1)
	})

	it('completePendingServerSync removes the account; status is none afterwards', () => {
		enqueuePendingServerSync(A)
		completePendingServerSync(A)
		expect(pendingServerSyncStatus(A)).toBe('none')
		expect(window.localStorage.getItem(PENDING_SERVER_SYNC_KEY)).toBeNull()
	})

	it('a thrown sender (a network error) waits and is not counted as a failure', async () => {
		enqueuePendingServerSync(A)
		for (let i = 0; i < PENDING_SERVER_SYNC_MAX_FAILURES + 5; i++) {
			await flushPendingServerSync(async () => {
				throw new Error('network')
			}, later())
		}
		expect(pendingServerSyncItems()[0].failures).toBe(0)
		expect(pendingServerSyncStatus(A)).toBe('pending')
		expect(pendingServerSyncNoticeVisible()).toBe(true)
	})

	it('the retry loop re-sends queued items on its interval once a sender is registered', async () => {
		jest.useFakeTimers()
		try {
			const send = jest.fn(async () => 'sent' as const)
			registerPendingSender(send)
			enqueuePendingServerSync(A)
			expect(send).not.toHaveBeenCalled()
			jest.advanceTimersByTime(PENDING_SERVER_SYNC_INTERVAL_MS)
			await Promise.resolve()
			await Promise.resolve()
			expect(send).toHaveBeenCalledWith(A.toLowerCase())
		} finally {
			resetPendingServerSyncForTest()
			jest.useRealTimers()
		}
	})

	it('a caller sees a queued sync (not the browser result); a server success is not pending', () => {
		expect(profileSyncPending(A, 'deferred')).toBe(false)
		enqueuePendingServerSync(A)
		expect(profileSyncPending(A, 'deferred')).toBe(true)
		expect(profileSyncPending(A, false)).toBe(true)
		expect(profileSyncPending(A, true)).toBe(false)
		completePendingServerSync(A)
		expect(profileSyncPending(A, 'deferred')).toBe(false)
	})

	it('(race): a success that started before a newer failure does not drop the newer intent', () => {
		const started = pendingServerSyncGeneration(A) // 0: nothing queued when v1 started
		enqueuePendingServerSync(A) // v2 failed and queued (a newer generation)
		completePendingServerSync(A, started) // v1 succeeds late
		expect(pendingServerSyncItems()).toHaveLength(1)
		expect(pendingServerSyncStatus(A)).toBe('pending')
	})

	it('a success that started with the current generation removes the item', () => {
		enqueuePendingServerSync(A)
		const started = pendingServerSyncGeneration(A)
		completePendingServerSync(A, started)
		expect(pendingServerSyncItems()).toEqual([])
	})

	it('an intent queued during a flush send is kept (the captured generation no longer matches)', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async (eoa) => {
			enqueuePendingServerSync(eoa) // a newer failure during the send
			return 'sent'
		}, later())
		expect(pendingServerSyncItems()).toHaveLength(1)
		expect(pendingServerSyncItems()[0].gen).toBe(2)
	})

	it('the notice shows only for unsynced items still retried; a failed item is not shown in the notice', async () => {
		expect(pendingServerSyncNoticeVisible()).toBe(false)
		enqueuePendingServerSync(A)
		expect(pendingServerSyncNoticeVisible()).toBe(true)
		for (let i = 0; i < PENDING_SERVER_SYNC_MAX_FAILURES; i++) await flushPendingServerSync(async () => 'failed', later())
		expect(pendingServerSyncNoticeVisible()).toBe(false)
		expect(pendingServerSyncStatus(A)).toBe('failed')
	})

	it('every queue change is announced on window (the notice listens)', () => {
		const seen = jest.fn()
		window.addEventListener(PENDING_SERVER_SYNC_EVENT, seen)
		try {
			enqueuePendingServerSync(A)
			completePendingServerSync(A)
			expect(seen).toHaveBeenCalledTimes(2)
		} finally {
			window.removeEventListener(PENDING_SERVER_SYNC_EVENT, seen)
		}
	})
})

describe('waiting is not failing; the native wallet session keeps the update pending', () => {
	it('no EOA key in this session (a deferred outcome) stays pending for a long time: never failed, shown in the notice', async () => {
		enqueuePendingServerSync(A)
		// The sender answers deferred, as the shell sender does when it has no EOA key (the key comes back with a read).
		for (let i = 0; i < PENDING_SERVER_SYNC_MAX_FAILURES * 3; i++) await flushPendingServerSync(async () => 'deferred', later())
		expect(pendingServerSyncStatus(A)).toBe('pending')
		expect(pendingServerSyncItems()[0].failures).toBe(0)
		expect(pendingServerSyncNoticeVisible()).toBe(true)
	})

	it('once the key is read back the same item is sent (no key is needed in the queue)', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async () => 'deferred', later())
		const send = jest.fn(async () => 'sent' as const)
		await flushPendingServerSync(send, later())
		expect(send).toHaveBeenCalledWith(A.toLowerCase())
		expect(pendingServerSyncItems()).toEqual([])
	})

	it('only an explicit refusal counts as a failure', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async () => 'deferred', later())
		await flushPendingServerSync(async () => 'failed', later())
		expect(pendingServerSyncItems()[0].failures).toBe(1)
	})
})

describe('the retry backoff grows and is capped at a few minutes; it never stops on time', () => {
	it('each deferral waits longer than the last, up to the cap', () => {
		expect(backoffDelayMs(PENDING_SERVER_SYNC_INTERVAL_MS, 0)).toBe(15_000)
		expect(backoffDelayMs(PENDING_SERVER_SYNC_INTERVAL_MS, 1)).toBe(30_000)
		expect(backoffDelayMs(PENDING_SERVER_SYNC_INTERVAL_MS, 2)).toBe(60_000)
		expect(backoffDelayMs(PENDING_SERVER_SYNC_INTERVAL_MS, 50)).toBe(RETRY_BACKOFF_CAP_MS)
		expect(RETRY_BACKOFF_CAP_MS).toBe(5 * 60_000)
	})

	it('an item is not sent before its next time; it is sent when that time has come', async () => {
		const T = 1_000_000
		enqueuePendingServerSync(A, T)
		await flushPendingServerSync(async () => 'deferred', T) // first deferral: next attempt at T + 30 s
		const send = jest.fn(async () => 'deferred' as const)
		await flushPendingServerSync(send, T + 10_000)
		expect(send).not.toHaveBeenCalled()
		await flushPendingServerSync(send, T + 30_000)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('after many deferrals the wait stays at the cap (never longer, never a stop)', async () => {
		const T = 1_000_000
		enqueuePendingServerSync(A, T)
		let now = T
		for (let i = 0; i < 12; i++) {
			await flushPendingServerSync(async () => 'deferred', now)
			now += RETRY_BACKOFF_CAP_MS
		}
		const item = pendingServerSyncItems()[0]
		expect(item.nextAt - (now - RETRY_BACKOFF_CAP_MS)).toBe(RETRY_BACKOFF_CAP_MS)
		expect(pendingServerSyncStatus(A)).toBe('pending')
	})

	it('a newer intent is sent at the next tick (its schedule is reset)', async () => {
		const T = 1_000_000
		enqueuePendingServerSync(A, T)
		await flushPendingServerSync(async () => 'deferred', T)
		enqueuePendingServerSync(A, T + 1)
		const send = jest.fn(async () => 'sent' as const)
		await flushPendingServerSync(send, T + 2)
		expect(send).toHaveBeenCalledTimes(1)
	})
})

describe('generations are never reused (no ABA loss)', () => {
	it('a generation is larger than every earlier one, also after the item was removed and queued again', () => {
		enqueuePendingServerSync(A)
		const first = pendingServerSyncGeneration(A)
		completePendingServerSync(A)
		enqueuePendingServerSync(A)
		const second = pendingServerSyncGeneration(A)
		expect(second).toBeGreaterThan(first)
	})

	it('a stale success of an older request does not remove the item queued again after it was removed', () => {
		enqueuePendingServerSync(A)
		const started = pendingServerSyncGeneration(A) // the in-flight request's generation
		completePendingServerSync(A) // removed meanwhile
		enqueuePendingServerSync(A) // queued again: a new generation, never the old one
		completePendingServerSync(A, started) // the stale success arrives late
		expect(pendingServerSyncItems()).toHaveLength(1)
		expect(pendingServerSyncItems()[0].gen).toBeGreaterThan(started)
	})

	it('the sequence is kept across a restart (a reload cannot reuse an older generation)', () => {
		enqueuePendingServerSync(A)
		const first = pendingServerSyncGeneration(A)
		completePendingServerSync(A)
		resetPendingServerSyncForTest() // the module state is gone; the stored sequence is not
		enqueuePendingServerSync(A)
		expect(pendingServerSyncGeneration(A)).toBeGreaterThan(first)
	})
})

describe('a failure counts only against its own request', () => {
	it('a failed send does not count against a newer intent queued during the send, and does not move its schedule', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async (eoa) => {
			enqueuePendingServerSync(eoa) // a newer intent during the send
			return 'failed'
		}, later())
		expect(pendingServerSyncItems()[0].failures).toBe(0)
		expect(pendingServerSyncItems()[0].nextAt).toBe(0)
	})

	it('a deferral during a send does not move the newer intent either', async () => {
		enqueuePendingServerSync(A)
		await flushPendingServerSync(async (eoa) => {
			enqueuePendingServerSync(eoa)
			return 'deferred'
		}, later())
		expect(pendingServerSyncItems()[0].attempts).toBe(0)
		expect(pendingServerSyncItems()[0].nextAt).toBe(0)
	})
})

