import { abortAfter, BOOT_REQUEST_TIMEOUT_MS, withBootTimeout } from './bootTimeout'

describe('bootTimeout (the start never waits forever on one stalled call)', () => {
	beforeEach(() => {
		jest.useFakeTimers()
	})
	afterEach(() => {
		jest.useRealTimers()
	})

	test('the request bound is 12 seconds', () => {
		expect(BOOT_REQUEST_TIMEOUT_MS).toBe(12_000)
	})

	test('a call that finishes in time returns its value', async () => {
		await expect(withBootTimeout(Promise.resolve('value'), 1000, 'fallback')).resolves.toBe('value')
	})

	test('a stalled call resolves to the fallback after the bound', async () => {
		const p = withBootTimeout(new Promise<string>(() => {}), 12_000, 'fallback')
		jest.advanceTimersByTime(11_999)
		let settled = false
		void p.then(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)
		jest.advanceTimersByTime(1)
		await expect(p).resolves.toBe('fallback')
	})

	test('a rejected call resolves to the fallback instead of stopping the start', async () => {
		await expect(withBootTimeout(Promise.reject(new Error('network down')), 1000, 'fallback')).resolves.toBe('fallback')
	})

	test('abortAfter aborts the signal after the bound, and done() cancels the timer', () => {
		const a = abortAfter(500)
		jest.advanceTimersByTime(499)
		expect(a.signal.aborted).toBe(false)
		jest.advanceTimersByTime(1)
		expect(a.signal.aborted).toBe(true)

		const b = abortAfter(500)
		b.done()
		jest.advanceTimersByTime(1000)
		expect(b.signal.aborted).toBe(false)
	})
})
