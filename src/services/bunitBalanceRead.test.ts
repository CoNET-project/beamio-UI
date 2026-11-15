/**
 * the B-Unit balance has three cases: a valid value, a valid zero, and a fault. A fault is never shown as zero.
 * SYNTHETIC values only.
 */
import { bunitBalanceView, readBUnitBalanceWithFallback, type BUnitBalanceRead } from './bunitBalanceRead'

const hangsUntilAborted = (signal: AbortSignal) =>
	new Promise<never>((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
	})

/** Lets the awaits inside the helper run, so its bound timer is registered before the test advances the clock. */
const flushMicrotasks = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

const rpcOk = (total: number): BUnitBalanceRead => ({ status: 'ok', balance: { total, free: 0, paid: total } })

describe('readBUnitBalanceWithFallback', () => {
	beforeEach(() => {
		jest.useFakeTimers()
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	test('a valid value from the API is shown as that value; the RPC is not read', async () => {
		const readRpc = jest.fn(async () => rpcOk(0))
		const r = await readBUnitBalanceWithFallback({
			readApi: async () => ({ total: 12.5, free: 2.5, paid: 10 }),
			readRpc,
		})
		expect(r).toEqual({ status: 'ok', balance: { total: 12.5, free: 2.5, paid: 10 } })
		expect(bunitBalanceView(r)).toEqual({ total: 12.5, free: 2.5, paid: 10 })
		expect(readRpc).not.toHaveBeenCalled()
	})

	test('a valid zero is a real answer: it is ok with total 0, not unavailable, and the RPC is not read', async () => {
		const readRpc = jest.fn(async () => rpcOk(7))
		const r = await readBUnitBalanceWithFallback({
			readApi: async () => ({ total: 0, free: 0, paid: 0 }),
			readRpc,
		})
		expect(r.status).toBe('ok')
		expect(bunitBalanceView(r)).toEqual({ total: 0, free: 0, paid: 0 })
		expect(readRpc).not.toHaveBeenCalled()
	})

	test('a fault: the API does not answer, the RPC fails too, the result is unavailable (not zero)', async () => {
		const readRpc = jest.fn(async (): Promise<BUnitBalanceRead> => ({ status: 'unavailable', reason: 'api_and_rpc_failed' }))
		const pending = readBUnitBalanceWithFallback({ readApi: hangsUntilAborted, readRpc })
		jest.advanceTimersByTime(12_000)
		const r = await pending
		expect(r).toEqual({ status: 'unavailable', reason: 'api_and_rpc_failed' })
		expect(bunitBalanceView(r)).toBe('unavailable')
		expect(readRpc).toHaveBeenCalledTimes(1)
	})

	test('a fault: the API fails, and the RPC never answers: unavailable after the bound, never zero', async () => {
		const pending = readBUnitBalanceWithFallback({
			readApi: async () => { throw new Error('network down') },
			readRpc: () => new Promise<BUnitBalanceRead>(() => {}),
		})
		await flushMicrotasks()
		jest.advanceTimersByTime(12_000)
		const r = await pending
		expect(r).toEqual({ status: 'unavailable', reason: 'rpc_timeout' })
		expect(bunitBalanceView(r)).toBe('unavailable')
	})

	test('an invalid API body falls back to the RPC value', async () => {
		const r = await readBUnitBalanceWithFallback({
			readApi: async () => null,
			readRpc: async () => rpcOk(3),
		})
		expect(bunitBalanceView(r)).toEqual({ total: 3, free: 0, paid: 3 })
	})
})
