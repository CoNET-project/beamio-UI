/**
 * The UI unlock backoff (project rule; FROZEN protocol 5.1 and 5.2). Synthetic times only.
 */
import { afterFailure, attemptUnlock, gateAt, LOCK_MS, memoryAttemptStore, ZERO_ATTEMPTS, type AttemptStore } from './passcodeBackoff'

const T0 = 1_800_000_000_000
const wrong = async () => false
const right = async () => true

describe('the third consecutive wrong input locks for 300 000 ms; expiry gives one attempt', () => {
	it('two wrong inputs do not lock; the third does, for the full five minutes', async () => {
		const store = memoryAttemptStore()
		expect((await attemptUnlock(store, T0, wrong)).kind).toBe('wrong')
		expect((await attemptUnlock(store, T0 + 1, wrong)).kind).toBe('wrong')
		const third = await attemptUnlock(store, T0 + 2, wrong)
		expect(third).toEqual({ kind: 'wrong', retryAfterMs: LOCK_MS, locked: true })
		expect(LOCK_MS).toBe(300_000)
	})

	it('while locked no comparison happens; the remaining time is reported', async () => {
		const store = memoryAttemptStore()
		for (let i = 0; i < 3; i++) await attemptUnlock(store, T0 + i, wrong)
		let compared = 0
		const out = await attemptUnlock(store, T0 + 1_000, async () => {
			compared++
			return true
		})
		expect(compared).toBe(0)
		expect(out).toEqual({ kind: 'locked', retryAfterMs: LOCK_MS - 998, rolledBack: false })
	})

	it('the five-minute boundary: one millisecond before the expiry is still locked; at the expiry one attempt is allowed', async () => {
		const store = memoryAttemptStore()
		for (let i = 0; i < 3; i++) await attemptUnlock(store, T0 + i, wrong)
		const lockedUntil = T0 + 2 + LOCK_MS
		expect((await attemptUnlock(store, lockedUntil - 1, right)).kind).toBe('locked')
		expect(await attemptUnlock(store, lockedUntil, right)).toEqual({ kind: 'correct' })
	})

	it('after the expiry one wrong input locks again for the full five minutes (the count is kept)', async () => {
		const store = memoryAttemptStore()
		for (let i = 0; i < 3; i++) await attemptUnlock(store, T0 + i, wrong)
		const after = T0 + 2 + LOCK_MS
		const again = await attemptUnlock(store, after, wrong)
		expect(again).toEqual({ kind: 'wrong', retryAfterMs: LOCK_MS, locked: true })
		expect(store.value?.failures).toBe(4)
	})

	it('a correct unlock clears the count: the next wrong input is the first again', async () => {
		const store = memoryAttemptStore()
		await attemptUnlock(store, T0, wrong)
		await attemptUnlock(store, T0 + 1, wrong)
		expect(await attemptUnlock(store, T0 + 2, right)).toEqual({ kind: 'correct' })
		expect(store.value).toEqual(ZERO_ATTEMPTS)
		expect((await attemptUnlock(store, T0 + 3, wrong)).kind).toBe('wrong')
		expect(store.value?.failures).toBe(1)
		expect(store.value?.lockedUntilMs).toBe(0)
	})
})

describe('one input counts once; the count is written before the input is judged', () => {
	it('the comparison sees the count already written', async () => {
		const store = memoryAttemptStore()
		let seenFailures = -1
		await attemptUnlock(store, T0, async () => {
			seenFailures = store.value?.failures ?? -1
			return false
		})
		expect(seenFailures).toBe(1)
	})

	it('a write that fails refuses the attempt and does not compare', async () => {
		const store: AttemptStore = {
			async read() {
				return null
			},
			async write() {
				throw new Error('disk full')
			},
		}
		let compared = false
		const out = await attemptUnlock(store, T0, async () => {
			compared = true
			return true
		})
		expect(out).toEqual({ kind: 'refused', reason: 'write_failed' })
		expect(compared).toBe(false)
	})

	it('a read that fails is unknown: the attempt is refused, nothing is compared', async () => {
		const store: AttemptStore = {
			async read() {
				throw new Error('timeout')
			},
			async write() {
				throw new Error('must not be called')
			},
		}
		let compared = false
		const out = await attemptUnlock(store, T0, async () => {
			compared = true
			return true
		})
		expect(out).toEqual({ kind: 'refused', reason: 'read_failed' })
		expect(compared).toBe(false)
	})
})

describe('a clock that runs back restarts the lock from now, for the full five minutes (fail closed)', () => {
	it('an attempt earlier than the last failure is locked from now, and the restart is written', async () => {
		const store = memoryAttemptStore({ failures: 1, lockedUntilMs: 0, lastFailureMs: T0 })
		const out = await attemptUnlock(store, T0 - 60_000, right)
		expect(out).toEqual({ kind: 'locked', retryAfterMs: LOCK_MS, rolledBack: true })
		expect(store.value?.lockedUntilMs).toBe(T0 - 60_000 + LOCK_MS)
	})

	it('gateAt reports the rollback without any stored lock', () => {
		expect(gateAt({ failures: 0, lockedUntilMs: 0, lastFailureMs: T0 }, T0 - 1)).toEqual({ kind: 'locked', retryAfterMs: LOCK_MS, rolledBack: true })
	})
})

describe('the state after a wrong input', () => {
	it('counts 1, 2 without a lock; 3 locks; the lock is from the failure time', () => {
		const s1 = afterFailure(ZERO_ATTEMPTS, T0)
		const s2 = afterFailure(s1, T0 + 1)
		const s3 = afterFailure(s2, T0 + 2)
		expect([s1.lockedUntilMs, s2.lockedUntilMs]).toEqual([0, 0])
		expect(s3.lockedUntilMs).toBe(T0 + 2 + LOCK_MS)
	})
})
