/**
 * @jest-environment node
 */
import { parseFirstIdentityStatusEvent, recordFirstIdentityStatus, getFirstIdentityStatus, resetFirstIdentityStatusForTest, subscribeFirstIdentityStatus } from './firstIdentityStatus'
import { createFirstIdentityReaction, type FirstIdentityReactionDeps } from './firstIdentityReaction'

jest.mock('@/utils/accountCreateRegisterFlag', () => ({ ACCOUNT_CREATE_REGISTER_ENABLED: true, FIRST_IDENTITY_STATUS_ENABLED: true }))

const ev = (over: Record<string, unknown>) => ({ type: 'firstIdentityStatus', state: 'registering', ...over })

beforeEach(() => resetFirstIdentityStatusForTest())

describe('N-11 the event: key whitelist and five states', () => {
	it('reads each of the five states', () => {
		for (const state of ['registering', 'registered', 'retry_later', 'identity_pending', 'failed']) {
			expect(parseFirstIdentityStatusEvent(ev({ state }))).toEqual({ state })
		}
	})
	it('reads the optional reason, attempt and retryAfterMs (retry_later only)', () => {
		expect(parseFirstIdentityStatusEvent(ev({ state: 'retry_later', reason: 'read_unavailable', attempt: 2, retryAfterMs: 4000 }))).toEqual({ state: 'retry_later', reason: 'read_unavailable', attempt: 2, retryAfterMs: 4000 })
	})
	it('any other key drops the event: key material, tag, password, fingerprint, signature', () => {
		for (const k of ['key', 'armor', 'fingerprint', 'signature', 'tag', 'password', 'eoa']) {
			expect(parseFirstIdentityStatusEvent(ev({ [k]: 'x' }))).toBeNull()
		}
	})
	it('an unknown state, a wrong type, a bad attempt, retryAfterMs outside retry_later: dropped; an unknown reason keeps the state', () => {
		expect(parseFirstIdentityStatusEvent(ev({ state: 'whatever' }))).toBeNull()
		expect(parseFirstIdentityStatusEvent({ type: 'other', state: 'registering' })).toBeNull()
		expect(parseFirstIdentityStatusEvent(ev({ attempt: 0 }))).toBeNull()
		expect(parseFirstIdentityStatusEvent(ev({ state: 'registering', retryAfterMs: 5 }))).toBeNull()
		expect(parseFirstIdentityStatusEvent(ev({ reason: 'new_reason' }))).toEqual({ state: 'registering' })
	})
})

describe('N-12 terminal states are not overwritten', () => {
	it('registered and failed stay; non-terminal states are replaced', () => {
		const seen: string[] = []
		subscribeFirstIdentityStatus((s) => seen.push(s.state))
		expect(recordFirstIdentityStatus({ state: 'registering' })).toBe(true)
		expect(recordFirstIdentityStatus({ state: 'retry_later' })).toBe(true)
		expect(recordFirstIdentityStatus({ state: 'registered' })).toBe(true)
		expect(recordFirstIdentityStatus({ state: 'failed' })).toBe(false)
		expect(recordFirstIdentityStatus({ state: 'registering' })).toBe(false)
		expect(getFirstIdentityStatus()).toEqual({ state: 'registered' })
		expect(seen).toEqual(['registering', 'retry_later', 'registered'])
	})
	it('failed stays too', () => {
		recordFirstIdentityStatus({ state: 'failed' })
		expect(recordFirstIdentityStatus({ state: 'registered' })).toBe(false)
		expect(getFirstIdentityStatus()).toEqual({ state: 'failed' })
	})
})

function reaction(over: Partial<FirstIdentityReactionDeps> = {}) {
	const calls: string[] = []
	let timer: { delay: number; fn: () => void } | null = null
	let failures = 0
	const deps: FirstIdentityReactionDeps = {
		setSetup: (v) => calls.push(`setup:${v}`),
		capFailed: () => { failures += 1; return failures >= 6 ? 'stop' : 'retry' },
		ladderDelayMs: () => 30_000,
		setTimer: (delay, fn) => { timer = { delay, fn }; calls.push(`timer:${delay}`) },
		clearTimer: () => { timer = null },
		hasTimer: () => timer !== null,
		startNow: () => calls.push('start'),
		showPending: () => calls.push('pending'),
		retryExhausted: () => calls.push('exhausted'),
		log: () => undefined,
		...over,
	}
	return { apply: createFirstIdentityReaction(deps), calls, fire: () => { const t = timer; timer = null; t?.fn() } }
}

describe('the page reaction (no create command, no button)', () => {
	it('registering: "setting up", nothing else', () => {
		const r = reaction()
		r.apply({ state: 'registering' })
		expect(r.calls).toEqual(['setup:setting_up'])
	})
	it('retry_later waits retryAfterMs (clamped to 1 s .. 5 min), then reads identityPublic once through the start', () => {
		const r = reaction()
		r.apply({ state: 'retry_later', retryAfterMs: 4000 })
		expect(r.calls).toEqual(['setup:setting_up', 'timer:4000'])
		r.fire()
		expect(r.calls[r.calls.length - 1]).toBe('start')
		const lo = reaction()
		lo.apply({ state: 'retry_later', retryAfterMs: 5 })
		expect(lo.calls).toContain('timer:1000')
		const hi = reaction()
		hi.apply({ state: 'retry_later', retryAfterMs: 99_999_999 })
		expect(hi.calls).toContain('timer:300000')
	})
	it('retry_later without retryAfterMs uses the page ladder; a second retry_later while a timer waits does not stack', () => {
		const r = reaction()
		r.apply({ state: 'retry_later' })
		r.apply({ state: 'retry_later' })
		expect(r.calls.filter((c) => c.startsWith('timer:'))).toEqual(['timer:30000'])
	})
	it('the retry cap stops the automatic retries: the existing retry-stopped notice, no further timer', () => {
		const r = reaction()
		for (let i = 0; i < 6; i++) { r.apply({ state: 'retry_later' }); r.fire() }
		expect(r.calls).toContain('exhausted')
		expect(r.calls.filter((c) => c.startsWith('timer:'))).toHaveLength(5)
	})
	it('registered: clears "setting up" and reads identityPublic at once; a waiting retry timer is dropped', () => {
		const r = reaction()
		r.apply({ state: 'retry_later', retryAfterMs: 4000 })
		r.apply({ state: 'registered' })
		expect(r.calls.slice(-2)).toEqual(['setup:idle', 'start'])
		r.fire()
		expect(r.calls.filter((c) => c === 'start')).toHaveLength(1)
	})
	it('identity_pending shows the pending notice, no retry; failed shows a failure, no retry, no start', () => {
		const p = reaction()
		p.apply({ state: 'identity_pending' })
		expect(p.calls).toEqual(['setup:idle', 'pending'])
		const f = reaction()
		f.apply({ state: 'failed', reason: 'conflict_other_key' })
		expect(f.calls).toEqual(['setup:failed'])
	})
})
