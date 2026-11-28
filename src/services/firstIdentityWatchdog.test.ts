/**
 * 0.53.52: the no-event watchdog of "setting up", with the page reaction. A declared capability and then silence lands on "identity pending"; every event
 * restarts the time; a terminal state or a pending notice clears it. SYNTHETIC; fake timers.
 */
import { createFirstIdentityWatchdog } from './firstIdentityWatchdog'
import { createFirstIdentityReaction, type FirstIdentityReactionDeps } from './firstIdentityReaction'
import { FIRST_IDENTITY_NO_EVENT_TIMEOUT_MS } from './firstIdentityStatus'
import { getFirstIdentitySetup, setFirstIdentitySetup } from './shellFirstIdentitySetup'

const T = FIRST_IDENTITY_NO_EVENT_TIMEOUT_MS

beforeEach(() => {
	jest.useFakeTimers()
	setFirstIdentitySetup('idle')
})
afterEach(() => jest.useRealTimers())

describe('the watchdog alone', () => {
	it('fires once after the time, and not before', () => {
		const fired = jest.fn()
		const w = createFirstIdentityWatchdog(fired)
		w.arm(T)
		jest.advanceTimersByTime(T - 1)
		expect(fired).not.toHaveBeenCalled()
		expect(w.armed()).toBe(true)
		jest.advanceTimersByTime(1)
		expect(fired).toHaveBeenCalledTimes(1)
		expect(w.armed()).toBe(false)
		jest.advanceTimersByTime(10 * T)
		expect(fired).toHaveBeenCalledTimes(1)
	})
	it('arming again restarts the time (one timer, never two)', () => {
		const fired = jest.fn()
		const w = createFirstIdentityWatchdog(fired)
		w.arm(T)
		jest.advanceTimersByTime(T - 1000)
		w.arm(T)
		jest.advanceTimersByTime(T - 1000)
		expect(fired).not.toHaveBeenCalled()
		jest.advanceTimersByTime(1000)
		expect(fired).toHaveBeenCalledTimes(1)
	})
	it('clear stops it', () => {
		const fired = jest.fn()
		const w = createFirstIdentityWatchdog(fired)
		w.arm(T)
		w.clear()
		jest.advanceTimersByTime(10 * T)
		expect(fired).not.toHaveBeenCalled()
		expect(w.armed()).toBe(false)
	})
})

function wired() {
	const calls: string[] = []
	const wd = createFirstIdentityWatchdog(() => {
		// what chat.ts does: silence is not a failure, the identity is pending
		calls.push('landed:pending')
		setFirstIdentitySetup('idle')
	})
	let timer: { fn: () => void } | null = null
	const deps: FirstIdentityReactionDeps = {
		setSetup: (v) => {
			calls.push(`setup:${v}`)
			setFirstIdentitySetup(v)
		},
		capFailed: () => 'retry',
		ladderDelayMs: () => 30_000,
		setTimer: (delay, fn) => {
			timer = { fn }
			calls.push(`timer:${delay}`)
		},
		clearTimer: () => {
			timer = null
		},
		hasTimer: () => timer !== null,
		startNow: () => calls.push('start'),
		showPending: () => calls.push('pending'),
		retryExhausted: () => calls.push('exhausted'),
		setWatchdog: (ms) => wd.arm(ms),
		clearWatchdog: () => wd.clear(),
		log: () => undefined,
	}
	return { apply: createFirstIdentityReaction(deps), calls, wd }
}

describe('the watchdog with the page reaction', () => {
	it('the capability is declared and setting up is shown (armed by the start), then silence: after the time "identity pending", no retry loop, no command', () => {
		const r = wired()
		setFirstIdentitySetup('setting_up')
		r.wd.arm(T) // what shellChatStart does through armFirstIdentityWatchdog
		jest.advanceTimersByTime(T)
		expect(getFirstIdentitySetup()).toBe('idle')
		expect(r.calls).toEqual(['landed:pending'])
	})
	it('a registering event restarts the time; "identity pending" comes T after the LAST event', () => {
		const r = wired()
		r.wd.arm(T)
		jest.advanceTimersByTime(T - 1000)
		r.apply({ state: 'registering' })
		jest.advanceTimersByTime(T - 1000)
		expect(getFirstIdentitySetup()).toBe('setting_up')
		jest.advanceTimersByTime(1000)
		expect(r.calls).toContain('landed:pending')
		expect(getFirstIdentitySetup()).toBe('idle')
	})
	it('retry_later is a planned wait: the watchdog starts after its delay (retryAfterMs clamped 1 s to 5 min, or the ladder), plus the time', () => {
		const r = wired()
		r.apply({ state: 'retry_later', retryAfterMs: 4000 })
		jest.advanceTimersByTime(4000 + T - 1)
		expect(getFirstIdentitySetup()).toBe('setting_up')
		jest.advanceTimersByTime(1)
		expect(r.calls).toContain('landed:pending')
		const ladder = wired()
		setFirstIdentitySetup('idle')
		ladder.apply({ state: 'retry_later' })
		jest.advanceTimersByTime(30_000 + T)
		expect(ladder.calls).toContain('landed:pending')
	})
	it.each([
		['registered', 'setup:idle'],
		['identity_pending', 'pending'],
		['failed', 'setup:failed'],
	])('%s clears the watchdog: it never fires afterwards (identity_pending is FI-06: no timeout is judged)', (state, mark) => {
		const r = wired()
		r.wd.arm(T)
		r.apply({ state: state as never })
		expect(r.calls).toContain(mark)
		expect(r.wd.armed()).toBe(false)
		const before = [...r.calls]
		jest.advanceTimersByTime(10 * T)
		expect(r.calls).toEqual(before)
		expect(r.calls).not.toContain('landed:pending')
	})
})

describe('the wiring and the constants (source)', () => {
	const fs = require('fs')
	const path = require('path')
	const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
	it('chat.ts binds the capability probe, the watchdog arm for the start, and the reaction watchdog', () => {
		const src = read('services/chat.ts')
		expect(src).toContain('firstIdentityStatusDeclared: async () =>')
		expect(src).toContain('probe.capabilities.includes(FIRST_IDENTITY_STATUS_CAPABILITY)')
		expect(src).toContain('armFirstIdentityWatchdog: () => armFirstIdentityWatchdog(FIRST_IDENTITY_NO_EVENT_TIMEOUT_MS)')
		expect(src).toContain('setWatchdog: (ms) => armFirstIdentityWatchdog(ms)')
		// the watchdog lands on "identity pending", not on the failed notice
		const at = src.indexOf('createFirstIdentityWatchdog(() => {')
		const block = src.slice(at, at + 520)
		expect(block).toContain("setFirstIdentitySetup('idle')")
		expect(block).toContain("setShellChatUiState('identity_pending', 'first_identity_watchdog')")
		expect(block).not.toContain("setFirstIdentitySetup('failed')")
		expect(src).toContain('watchFirstIdentityFailed({')
		expect(src).toContain('clearWatchdog: () => clearFirstIdentityWatchdog()')
	})
	it('the initial timeout is the Android rhythm value (5 minutes), not shorter than one whole SDK run', () => {
		expect(T).toBeGreaterThanOrEqual(180_000)
		expect(T).toBe(300_000)
	})
	it('the capability name is the one the SDKs declare; the click path stays closed in this release; the status path is on in every build', () => {
		expect(read('services/firstIdentityStatus.ts')).toContain("FIRST_IDENTITY_STATUS_CAPABILITY = 'identity.first.status.v1'")
		expect(read('utils/pgpIdentityCreateFlag.ts')).toContain("export const PGP_IDENTITY_CREATE_ENABLED: boolean = pgpIdentityCreateEnabledFor(process.env.REACT_APP_PGP_IDENTITY_CREATE_ENABLED)")
		expect(read('utils/accountCreateRegisterFlag.ts')).toContain('export const FIRST_IDENTITY_STATUS_ENABLED = true as const')
		expect(read('utils/accountCreateRegisterFlag.ts')).not.toContain('process.env.REACT_APP_NEW_ACCOUNT_REGISTRATION)\n')
	})
})
