/**
 * @jest-environment node
 *
 * v10.2 r4 §2.2, CT series for the native create wait (event first, 10-minute fallback, retry admission). The CT numbers follow the
 * plan's CT-1…CT-16; the cases that need the page are in CreateUsernamePinScreen.ct.static.test.ts.
 */
import {
	cancelCreateWait,
	canStartCreate,
	NATIVE_CREATE_FALLBACK_MS,
	onCreateResult,
	scheduleCreateFallback,
	startCreateWait,
	tickCreateWait,
} from './nativeCreateWait'

const MIN = 60 * 1000
const HOLD = { kind: 'refused' as const, code: 'locked' }
const VALID = { kind: 'address' as const }

describe('native create wait (CT series)', () => {
	it('CT-1a: at 9:59 the wait is still pending (no fallback)', () => {
		const s = startCreateWait(0, 1)
		expect(tickCreateWait(s, 9 * MIN + 59 * 1000).kind).toBe('pending')
	})

	it('CT-1b: at 10:00 the wait falls back', () => {
		const s = startCreateWait(0, 1)
		expect(tickCreateWait(s, NATIVE_CREATE_FALLBACK_MS).kind).toBe('fallback')
	})

	it('CT-2: a result before 10 minutes is delivered and the wait is idle (event first)', () => {
		const s = startCreateWait(0, 1)
		const r = onCreateResult(s)
		expect(r.deliver).toBe(true)
		expect(r.state.kind).toBe('idle')
	})

	it('CT-3: after the fallback, a late result of the same request is delivered once; a second one is dropped', () => {
		const fb = tickCreateWait(startCreateWait(0, 1), NATIVE_CREATE_FALLBACK_MS)
		const first = onCreateResult(fb)
		expect(first.deliver).toBe(true)
		const second = onCreateResult(first.state)
		expect(second.deliver).toBe(false)
	})

	it('CT-4: after the fallback, a retry with an unknown (locked) reread does not send', () => {
		const fb = tickCreateWait(startCreateWait(0, 1), NATIVE_CREATE_FALLBACK_MS)
		expect(canStartCreate(fb, HOLD)).toBe(false)
	})

	it('CT-5: after the fallback alone (the native page may still be open), a retry is not admitted even with a valid reread (CT-13)', () => {
		const fb = tickCreateWait(startCreateWait(0, 1), NATIVE_CREATE_FALLBACK_MS)
		expect(canStartCreate(fb, VALID)).toBe(false)
	})

	it('CT-13b: after the fallback, a late terminal result makes the wait idle; then a retry is admitted with a valid reread', () => {
		const fb = tickCreateWait(startCreateWait(0, 1), NATIVE_CREATE_FALLBACK_MS)
		const late = onCreateResult(fb)
		expect(canStartCreate(late.state, VALID)).toBe(true)
		expect(canStartCreate(late.state, HOLD)).toBe(false)
	})

	it('CT-13c: after the fallback, the cancel is cancelled; a retry is unavailable until the terminal result; then admitted with a valid reread', () => {
		const fb = tickCreateWait(startCreateWait(0, 1), NATIVE_CREATE_FALLBACK_MS)
		const cancelled = cancelCreateWait(fb)
		expect(cancelled.kind).toBe('cancelled')
		expect(canStartCreate(cancelled, VALID)).toBe(false)
		const terminal = onCreateResult(cancelled)
		expect(canStartCreate(terminal.state, VALID)).toBe(true)
	})

	it('CT-15 (r7 §一): the cancel ends the wait display; a retry is unavailable until the terminal result of the same request arrives', () => {
		const cancelled = cancelCreateWait(startCreateWait(0, 1))
		expect(cancelled.kind).toBe('cancelled')
		expect(canStartCreate(cancelled, VALID)).toBe(false)
		expect(canStartCreate(cancelled, HOLD)).toBe(false)
	})

	it('CT-15a (r7): a retry pressed while cancelled sends nothing; the state stays cancelled', () => {
		const cancelled = cancelCreateWait(startCreateWait(0, 1))
		expect(canStartCreate(cancelled, VALID)).toBe(false)
		expect(cancelled.kind).toBe('cancelled')
	})

	it('CT-15b (r7): the native page closed (cancelled event) is a terminal result; the retry becomes available after it, with a valid reread', () => {
		const cancelled = cancelCreateWait(startCreateWait(0, 1))
		const terminal = onCreateResult(cancelled)
		expect(terminal.deliver).toBe(true)
		expect(canStartCreate(terminal.state, VALID)).toBe(true)
		expect(canStartCreate(terminal.state, HOLD)).toBe(false)
	})

	it('CT-15c (r7): a late ok after the cancel is delivered once; a second one is dropped', () => {
		const cancelled = cancelCreateWait(startCreateWait(0, 1))
		const first = onCreateResult(cancelled)
		expect(first.deliver).toBe(true)
		expect(onCreateResult(first.state).deliver).toBe(false)
	})

	it('CT-12: no short timeout in the wait: the only fallback constant is 10 minutes', () => {
		expect(NATIVE_CREATE_FALLBACK_MS).toBe(10 * 60 * 1000)
	})

	it('CT-6: a pending wait never admits a new create (no automatic duplicate)', () => {
		expect(canStartCreate(startCreateWait(0, 1), VALID)).toBe(false)
	})

	it('CT-7: a result with no wait is dropped', () => {
		expect(onCreateResult({ kind: 'idle' }).deliver).toBe(false)
	})

	it('CT-8: the fallback timer fires at 10:00 with fake timers and is cancelled by an earlier result', () => {
		jest.useFakeTimers()
		try {
			const onFallback = jest.fn()
			scheduleCreateFallback(onFallback)
			jest.advanceTimersByTime(9 * MIN + 59 * 1000)
			expect(onFallback).not.toHaveBeenCalled()
			jest.advanceTimersByTime(1000)
			expect(onFallback).toHaveBeenCalledTimes(1)
		} finally {
			jest.useRealTimers()
		}
	})

	it('CT-8b: a cancel before 10:00 prevents the fallback (event first)', () => {
		jest.useFakeTimers()
		try {
			const onFallback = jest.fn()
			const cancel = scheduleCreateFallback(onFallback)
			jest.advanceTimersByTime(5 * MIN)
			cancel()
			jest.advanceTimersByTime(10 * MIN)
			expect(onFallback).not.toHaveBeenCalled()
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('TR-4: the fallback with fake timers, late result, and retry admission', () => {
	it('TR-4: 9:59 no fallback; 10:00 fallback; a late result is delivered once; retry admitted only after the terminal result with a valid reread', () => {
		jest.useFakeTimers()
		try {
			let state = startCreateWait(Date.now(), 1)
			const fallbackTimer = jest.fn(() => {
				state = tickCreateWait(state, Date.now())
			})
			scheduleCreateFallback(fallbackTimer)
			jest.advanceTimersByTime(9 * MIN + 59 * 1000)
			expect(fallbackTimer).not.toHaveBeenCalled()
			expect(state.kind).toBe('pending')
			jest.advanceTimersByTime(1000)
			expect(fallbackTimer).toHaveBeenCalledTimes(1)
			expect(state.kind).toBe('fallback')
			// the late result of the same request is delivered once
			const late = onCreateResult(state)
			expect(late.deliver).toBe(true)
			expect(onCreateResult(late.state).deliver).toBe(false)
			// after the fallback alone a retry is not admitted (CT-13); only a terminal result or a cancel makes the wait idle
			expect(canStartCreate(state, HOLD)).toBe(false)
			expect(canStartCreate(state, VALID)).toBe(false)
			expect(canStartCreate(late.state, VALID)).toBe(true)
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('CT-16b: a late terminal result after a cancel is delivered once (r5 §五)', () => {
	it('after the cancel, a late ok of the same request is delivered once; a second one is dropped', () => {
		const cancelled = cancelCreateWait(startCreateWait(0, 1))
		expect(cancelled.kind).toBe('cancelled')
		const first = onCreateResult(cancelled)
		expect(first.deliver).toBe(true)
		expect(onCreateResult(first.state).deliver).toBe(false)
	})

	it('after the cancel and the late result, a retry is admitted only with a valid reread', () => {
		const late = onCreateResult(cancelCreateWait(startCreateWait(0, 1)))
		expect(canStartCreate(late.state, VALID)).toBe(true)
		expect(canStartCreate(late.state, HOLD)).toBe(false)
	})

	it('a cancelled wait does not admit a new request before the terminal result (no duplicate)', () => {
		expect(canStartCreate(cancelCreateWait(startCreateWait(0, 1)), HOLD)).toBe(false)
		expect(canStartCreate(cancelCreateWait(startCreateWait(0, 1)), VALID)).toBe(false)
	})
})
