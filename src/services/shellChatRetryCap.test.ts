/**
 * @jest-environment node
 *
 * the limit of automatic chat start retries in a shell. The sixth consecutive failure stops them; a success
 * or the manual retry starts the count again. SYNTHETIC values only.
 */
import {
	createShellRetryCap,
	getShellRetryExhausted,
	registerShellRetryNow,
	requestShellRetryNow,
	SHELL_CHAT_RETRY_LIMIT,
	setShellRetryExhausted,
	subscribeShellRetryExhausted,
} from './shellChatRetryCap'

describe('the retry cap', () => {
	it('the limit is six consecutive failures', () => {
		expect(SHELL_CHAT_RETRY_LIMIT).toBe(6)
	})

	it('failures one to five retry; the sixth stops', () => {
		const cap = createShellRetryCap()
		for (let i = 1; i <= 5; i += 1) expect(cap.failed()).toBe('retry')
		expect(cap.failed()).toBe('stop')
		expect(cap.count()).toBe(6)
	})

	it('a success starts the count again', () => {
		const cap = createShellRetryCap()
		for (let i = 0; i < 5; i += 1) cap.failed()
		cap.succeeded()
		expect(cap.count()).toBe(0)
		expect(cap.failed()).toBe('retry')
	})

	it('the manual retry starts the count again', () => {
		const cap = createShellRetryCap()
		for (let i = 0; i < 6; i += 1) cap.failed()
		cap.reset()
		expect(cap.failed()).toBe('retry')
	})

	it('the limit can be given (a test seam)', () => {
		const cap = createShellRetryCap(2)
		expect(cap.failed()).toBe('retry')
		expect(cap.failed()).toBe('stop')
	})
})

describe('the stopped-retries state and its manual retry', () => {
	it('the state is set and read, and subscribers are told', () => {
		const seen: boolean[] = []
		const off = subscribeShellRetryExhausted((v) => seen.push(v))
		setShellRetryExhausted(true)
		expect(getShellRetryExhausted()).toBe(true)
		setShellRetryExhausted(true)
		setShellRetryExhausted(false)
		off()
		expect(seen).toEqual([true, false])
	})

	it('the manual retry calls the handler the chat module registered', () => {
		let calls = 0
		registerShellRetryNow(() => {
			calls += 1
		})
		requestShellRetryNow()
		expect(calls).toBe(1)
		registerShellRetryNow(null)
		requestShellRetryNow()
		expect(calls).toBe(1)
	})
})
