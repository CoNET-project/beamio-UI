/**
 * the account read is retried on 30 s, 2 min, 10 min; after the last retry it is unavailable (not a silent loop), and a
 * vault lock or sign-out stops it. SYNTHETIC values only.
 */
import { loadUserInfoWithBackoff, USER_INFO_RETRY_DELAYS_MS } from './userInfoLoad'

const failing = () => Promise.resolve({ status: 'network_error' as const, reason: 'registry_read_timeout' })

describe('loadUserInfoWithBackoff', () => {
	it('the ladder is 30 s, 2 min, 10 min', () => {
		expect([...USER_INFO_RETRY_DELAYS_MS]).toEqual([30_000, 120_000, 600_000])
	})

	it('a failing read is retried on the ladder and then is unavailable (four reads, not a loop)', async () => {
		const waits: number[] = []
		const read = jest.fn(failing)
		const r = await loadUserInfoWithBackoff(read, { wait: async (ms) => void waits.push(ms), stopped: () => false })
		expect(r).toEqual({ status: 'unavailable', reason: 'network_error', reads: 4 })
		expect(read).toHaveBeenCalledTimes(4)
		expect(waits).toEqual([30_000, 120_000, 600_000])
	})

	it('a valid empty answer ends as unavailable with reason no_account (it is not taken as a finished load)', async () => {
		const r = await loadUserInfoWithBackoff(() => Promise.resolve({ status: 'no_account' as const }), { wait: async () => undefined, stopped: () => false })
		expect(r).toEqual({ status: 'unavailable', reason: 'no_account', reads: 4 })
	})

	it('a later success stops the ladder and returns the account', async () => {
		const waits: number[] = []
		const results = [failing, () => Promise.resolve({ status: 'ok' as const, info: { accountName: 'synthtag' } })]
		let i = 0
		const r = await loadUserInfoWithBackoff(() => results[i++](), { wait: async (ms) => void waits.push(ms), stopped: () => false })
		expect(r).toEqual({ status: 'ok', info: { accountName: 'synthtag' }, reads: 2 })
		expect(waits).toEqual([30_000])
	})

	it('a read that throws is a network error and is retried', async () => {
		const read = jest.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce({ status: 'ok', info: 'x' })
		const r = await loadUserInfoWithBackoff(read, { wait: async () => undefined, stopped: () => false })
		expect(r).toEqual({ status: 'ok', info: 'x', reads: 2 })
	})

	it('a vault lock during the wait stops the loop before the next read', async () => {
		let stop = false
		const read = jest.fn(failing)
		const r = await loadUserInfoWithBackoff(read, {
			wait: async () => {
				stop = true
			},
			stopped: () => stop,
		})
		expect(r).toEqual({ status: 'stopped', reads: 1 })
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('a stop before the first read reads nothing', async () => {
		const read = jest.fn(failing)
		const r = await loadUserInfoWithBackoff(read, { wait: async () => undefined, stopped: () => true })
		expect(r).toEqual({ status: 'stopped', reads: 0 })
		expect(read).not.toHaveBeenCalled()
	})

	it('the delays can be given (the receipt records the value used)', async () => {
		const waits: number[] = []
		await loadUserInfoWithBackoff(failing, { wait: async (ms) => void waits.push(ms), stopped: () => false, delays: [5] })
		expect(waits).toEqual([5])
	})
})
