/**
 * the excluded-cards list is read once at boot and the read is shared. A stalled read must settle after the bound, so
 * every caller gets the last trusted set (empty on the first boot), and the next call reads again. SYNTHETIC addresses only.
 */
import { loadApiExcludedUserCards } from './apiExcludedUserCards'

const abortableNever = (_url: string, init?: RequestInit) =>
	new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
	})

describe('loadApiExcludedUserCards (boot read is bounded)', () => {
	const realFetch = global.fetch
	beforeEach(() => {
		jest.useFakeTimers()
	})
	afterEach(() => {
		jest.useRealTimers()
		global.fetch = realFetch
	})

	test('a stalled boot read settles after 12 seconds with an empty set, and does not hold later callers', async () => {
		const fetchMock = jest.fn(abortableNever)
		global.fetch = fetchMock as unknown as typeof fetch
		const first = loadApiExcludedUserCards()
		let settled = false
		void first.then(() => { settled = true })
		jest.advanceTimersByTime(11_999)
		await Promise.resolve()
		expect(settled).toBe(false)
		jest.advanceTimersByTime(1)
		const set = await first
		expect(set.size).toBe(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// The shared read is released: the next caller reads again (it is not handed the stalled promise).
		global.fetch = jest.fn(async () => ({
			ok: true,
			json: async () => ({ ok: true, addresses: ['0x00000000000000000000000000000000000000aa'] }),
		})) as unknown as typeof fetch
		const second = await loadApiExcludedUserCards()
		expect(second.has('0x00000000000000000000000000000000000000aa')).toBe(true)
	})
})
