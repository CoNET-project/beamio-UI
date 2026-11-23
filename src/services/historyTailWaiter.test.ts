import { createHistoryTailWaiter } from './historyTailWaiter'

const CLIENT_A = { id: 'A' }
const CLIENT_B = { id: 'B' }

describe('history tail completion signal', () => {
	it('(+) a tail batch completes a pending waiter for the active client with true', async () => {
		const w = createHistoryTailWaiter()
		const p = w.await(() => CLIENT_A, 60_000)
		w.noteTail(CLIENT_A, true)
		await expect(p).resolves.toBe(true)
	})
	it('(+) an empty tail batch counts (no records is still a completed load)', async () => {
		const w = createHistoryTailWaiter()
		const p = w.await(() => CLIENT_A, 60_000)
		w.noteTail(CLIENT_A, true)
		await expect(p).resolves.toBe(true)
	})
	it('(-) a backfill batch (isTail false) does not complete the waiter', async () => {
		jest.useFakeTimers()
		try {
			const w = createHistoryTailWaiter()
			const p = w.await(() => CLIENT_A, 1000)
			w.noteTail(CLIENT_A, false)
			jest.advanceTimersByTime(1001)
			await expect(p).resolves.toBe(false)
		} finally {
			jest.useRealTimers()
		}
	})
	it('(-) a tail of another client does not complete the waiter for the active client', async () => {
		jest.useFakeTimers()
		try {
			const w = createHistoryTailWaiter()
			const p = w.await(() => CLIENT_A, 1000)
			w.noteTail(CLIENT_B, true)
			jest.advanceTimersByTime(1001)
			await expect(p).resolves.toBe(false)
		} finally {
			jest.useRealTimers()
		}
	})
	it('(+) a tail already delivered for the active client resolves at once (no wait, no second load)', async () => {
		const w = createHistoryTailWaiter()
		w.noteTail(CLIENT_A, true)
		expect(w.deliveredFor(CLIENT_A)).toBe(true)
		await expect(w.await(() => CLIENT_A, 60_000)).resolves.toBe(true)
	})
	it('(-) no tail within the bound resolves false (failure is named, never a hang)', async () => {
		jest.useFakeTimers()
		try {
			const w = createHistoryTailWaiter()
			const p = w.await(() => CLIENT_A, 5000)
			jest.advanceTimersByTime(5001)
			await expect(p).resolves.toBe(false)
		} finally {
			jest.useRealTimers()
		}
	})
})
