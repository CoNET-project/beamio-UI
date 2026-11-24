/**
 * @jest-environment node
 */
import { COLD_START_WINDOW_MS, createColdStartBackoff } from './coldStartBackoff'

function clock() {
	let t = 1_000_000
	return { now: () => t, advance: (ms: number) => void (t += ms) }
}

/** Runs the schedule as the caller would: wait the delay, attempt again (still not_ready), until exhausted. */
function runToExhaustion(key: 'identityPublic' | 'walletStatus' | 'nativeMnemonicPreread' = 'identityPublic') {
	const c = clock()
	const b = createColdStartBackoff(c.now)
	const delays: number[] = []
	for (let i = 0; i < 100; i++) {
		const s = b.next(key)
		if (s.kind === 'exhausted') return { delays, elapsed: s.elapsedMs, b, c }
		delays.push(s.delayMs)
		c.advance(s.delayMs)
	}
	throw new Error('never exhausted')
}

describe('cold-start backoff schedule', () => {
	it('after the immediate first attempt: 1, 2, 4, 8, 16 s, then 16 s each, the last cut to the 180 s window', () => {
		const { delays, elapsed } = runToExhaustion()
		expect(COLD_START_WINDOW_MS).toBe(180_000)
		expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 16000, 16000])
		expect(delays[delays.length - 1]).toBeLessThanOrEqual(16000)
		expect(delays.reduce((a, b) => a + b, 0)).toBe(COLD_START_WINDOW_MS)
		expect(elapsed).toBe(COLD_START_WINDOW_MS)
	})
	it('there is no attempt-count stop: the attempts go on as long as the window lasts (many more than the old six-failure cap)', () => {
		expect(runToExhaustion().delays.length).toBeGreaterThan(10)
	})
	it('the window used up is exhausted, and stays exhausted until a reset', () => {
		const { b, c } = runToExhaustion()
		expect(b.next('identityPublic').kind).toBe('exhausted')
		c.advance(5000)
		expect(b.next('identityPublic').kind).toBe('exhausted')
	})
	it('each command has its own clock (identityPublic, walletStatus, nativeMnemonicPreread)', () => {
		const c = clock()
		const b = createColdStartBackoff(c.now)
		expect(b.next('identityPublic')).toMatchObject({ kind: 'wait', delayMs: 1000, attempt: 1 })
		c.advance(1000)
		expect(b.next('identityPublic')).toMatchObject({ kind: 'wait', delayMs: 2000, attempt: 2 })
		expect(b.next('walletStatus')).toMatchObject({ kind: 'wait', delayMs: 1000, attempt: 1 })
		expect(b.next('nativeMnemonicPreread')).toMatchObject({ kind: 'wait', delayMs: 1000, attempt: 1 })
	})
})

describe('resets start the clock again (success, account switch, foreground, manual retry)', () => {
	it('reset of one command restarts it and leaves the others', () => {
		const { b, c } = runToExhaustion('identityPublic')
		b.next('walletStatus')
		b.reset('identityPublic')
		expect(b.attempts('identityPublic')).toBe(0)
		expect(b.next('identityPublic')).toMatchObject({ kind: 'wait', delayMs: 1000, attempt: 1 })
		expect(b.attempts('walletStatus')).toBe(1)
		c.advance(1)
	})
	it('reset with no key clears every command', () => {
		const c = clock()
		const b = createColdStartBackoff(c.now)
		b.next('identityPublic')
		b.next('walletStatus')
		b.reset()
		expect(b.attempts('identityPublic')).toBe(0)
		expect(b.attempts('walletStatus')).toBe(0)
	})
	it('after a reset the window is a fresh 180 s even when the old one was spent', () => {
		const { b } = runToExhaustion()
		b.reset('identityPublic')
		const s = b.next('identityPublic')
		expect(s).toMatchObject({ kind: 'wait', delayMs: 1000 })
	})
})
