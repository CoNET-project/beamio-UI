/**
 * @jest-environment node
 */
/**
 * R76-3 / R77: the SSE start's step timeouts (the signing round trip and the entry wrap). A step that does not answer in time rejects
 * with a named error; the start-up error log carries its class (sign_timeout, wrap_timeout, fetch_failed, other). Runs the SDK build
 * (vendor/conet-chat-sdk/dist, rebuilt from the source before this test).
 */
import { ListenStepError, LISTEN_SIGN_TIMEOUT_MS, WRAP_TIMEOUT_MS, listenErrorClass, listenErrorLogLine, listenStatusReason, sanitizeErrorMessage, withStepTimeout } from '../../vendor/conet-chat-sdk/dist/worker/gossip-core.js'

describe('SSE start step timeouts (R76-3, R77)', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('the signing round trip and the wrap each have a bounded timeout, and the wrap timeout is shorter than the sign timeout', () => {
		expect(LISTEN_SIGN_TIMEOUT_MS).toBeGreaterThan(0)
		expect(WRAP_TIMEOUT_MS).toBeGreaterThan(0)
		expect(WRAP_TIMEOUT_MS).toBeLessThan(LISTEN_SIGN_TIMEOUT_MS)
	})

	it('a step that answers in time resolves with its value', async () => {
		await expect(withStepTimeout(Promise.resolve('armored'), 'wrap', 1000)).resolves.toBe('armored')
	})

	it('a signing round trip that never answers rejects with sign_timeout after the sign timeout', async () => {
		jest.useFakeTimers()
		const never = new Promise<string>(() => undefined)
		const p = withStepTimeout(never, 'sign', LISTEN_SIGN_TIMEOUT_MS)
		jest.advanceTimersByTime(LISTEN_SIGN_TIMEOUT_MS)
		await expect(p).rejects.toMatchObject({ name: 'ListenStepError', step: 'sign', message: 'sign_timeout' })
	})

	it('a wrap that never answers rejects with wrap_timeout after the wrap timeout, not before', async () => {
		jest.useFakeTimers()
		const never = new Promise<string>(() => undefined)
		let settled = false
		const p = withStepTimeout(never, 'wrap', WRAP_TIMEOUT_MS).catch((e: unknown) => {
			settled = true
			throw e
		})
		jest.advanceTimersByTime(WRAP_TIMEOUT_MS - 1)
		await Promise.resolve()
		expect(settled).toBe(false)
		jest.advanceTimersByTime(1)
		await expect(p).rejects.toBeInstanceOf(ListenStepError)
		await expect(p).rejects.toMatchObject({ message: 'wrap_timeout' })
	})

	it('a step error that settles first is not replaced by the timeout', async () => {
		jest.useFakeTimers()
		const failing = Promise.reject(new Error('boom'))
		await expect(withStepTimeout(failing, 'sign', LISTEN_SIGN_TIMEOUT_MS)).rejects.toThrow('boom')
		jest.advanceTimersByTime(LISTEN_SIGN_TIMEOUT_MS)
	})

	it('the start-up error class: a named timeout, a failed fetch, or other (never the message of other)', () => {
		expect(listenErrorClass(new ListenStepError('sign'))).toBe('sign_timeout')
		expect(listenErrorClass(new ListenStepError('wrap'))).toBe('wrap_timeout')
		expect(listenErrorClass(new TypeError('Failed to fetch'))).toBe('fetch_failed')
		expect(listenErrorClass(new Error('something else'))).toBe('other')
		expect(listenErrorClass(undefined)).toBe('other')
	})

	it('R79: the status reason is the class only, never the raw message', () => {
		expect(listenStatusReason(new ListenStepError('sign'))).toBe('sign_timeout')
		expect(listenStatusReason(new Error('leaked 0xABCDEF0123456789ABCDEF'))).toBe('other')
	})

	it('R79: the log line carries the class for named errors, and a sanitized message for other', () => {
		expect(listenErrorLogLine(new ListenStepError('wrap'))).toBe('startListen error [wrap_timeout]')
		const line = listenErrorLogLine(new Error('bad 0x0123456789abcdef0123 and -----BEGIN PGP PRIVATE KEY BLOCK----- x -----END PGP PRIVATE KEY BLOCK-----'))
		expect(line).toContain('startListen error [other]:')
		expect(line).not.toContain('0x0123456789abcdef')
		expect(line).not.toContain('BEGIN PGP')
		expect(line).toContain('[armor]')
	})

	it('R79: sanitizeErrorMessage removes long hex and base64 runs and cuts the text', () => {
		expect(sanitizeErrorMessage('a b '.repeat(100))).toHaveLength(120)
		expect(sanitizeErrorMessage('key QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY= end')).not.toContain('QUJD')
	})
})
