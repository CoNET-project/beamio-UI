/**
 * the PGP temporary state is retried on 30 s, 2 min, 10 min, then the automatic retries stop (a manual retry is offered); a start that
 * succeeds clears the state. SYNTHETIC values only.
 */
import {
	getShellPgpTemporary,
	getShellPgpTemporaryStopped,
	nextPgpTemporaryDelay,
	PGP_TEMPORARY_RETRY_DELAYS_MS,
	setShellPgpTemporary,
	setShellPgpTemporaryStopped,
} from './shellPgpTemporary'

describe('the temporary PGP retry ladder is capped', () => {
	it('the ladder is 30 s, 2 min, 10 min', () => {
		expect([...PGP_TEMPORARY_RETRY_DELAYS_MS]).toEqual([30_000, 120_000, 600_000])
	})

	it('after the three retries the ladder is spent: the delay is null, not 10 min again', () => {
		expect(nextPgpTemporaryDelay(0)).toBe(30_000)
		expect(nextPgpTemporaryDelay(1)).toBe(120_000)
		expect(nextPgpTemporaryDelay(2)).toBe(600_000)
		expect(nextPgpTemporaryDelay(3)).toBeNull()
		expect(nextPgpTemporaryDelay(10)).toBeNull()
	})
})

describe('the temporary state is cleared on success and stopped retries are a separate flag', () => {
	beforeEach(() => {
		setShellPgpTemporary(false)
	})

	it('setting the state, then the stopped flag, then clearing the state clears both', () => {
		setShellPgpTemporary(true)
		expect(getShellPgpTemporary()).toBe(true)
		setShellPgpTemporaryStopped(true)
		expect(getShellPgpTemporaryStopped()).toBe(true)
		setShellPgpTemporary(false)
		expect(getShellPgpTemporary()).toBe(false)
		expect(getShellPgpTemporaryStopped()).toBe(false)
	})

	it('a new temporary result starts the ladder again (the stopped flag is reset)', () => {
		setShellPgpTemporary(true)
		setShellPgpTemporaryStopped(true)
		setShellPgpTemporary(true)
		expect(getShellPgpTemporaryStopped()).toBe(false)
	})
})
