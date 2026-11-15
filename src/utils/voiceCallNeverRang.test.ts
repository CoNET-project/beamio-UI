// Pure helpers; stub the modules voiceCallSession imports.
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
jest.mock('./cashTreesNativePwaLog', () => ({ publishNativePwaLog: () => {} }))
const dispatched: Array<{ action: string; payload: Record<string, unknown> }> = []
jest.mock('./cashTreesNativeNfc', () => ({
	dispatchNativeSystemCallAction: (action: string, payload: Record<string, unknown>) => {
		dispatched.push({ action, payload })
		return true
	},
}))

import {
	askShellWhichIncomingCallsRang,
	markIncomingCallNeverRang,
	mergePhoneCallRecord,
	noteNativeCallAnswered,
	phoneCallStatusForPeerHangup,
	takeIncomingCallsToAskRang,
	replacePhoneCallInRows,
	findPhoneCallByIds,
	phoneCallIdsOverlap,
	sameCallId,
} from './voiceCallSession'
import { RANG_TRACKING_KEY } from './incomingRangTracking'

const now = Date.now()
/** the old Android shell (queryIncomingCallOutcome, no BeamioShell) for these tests. */
const useOldShell = () => {
	delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
	;(window as unknown as { CashTreesAndroid?: unknown }).CashTreesAndroid = { queryIncomingCallOutcome: () => {} }
}
const row = (id: string, extra: Partial<PhoneCallRecord> = {}): PhoneCallRecord => ({
	callId: `c-${id}`,
	sessionId: `s-${id}`,
	peerAddress: '0x0000000000000000000000000000000000000001',
	direction: 'incoming',
	status: 'cancelled',
	createdAt: now - 60_000,
	endedAt: now - 50_000,
	...extra,
})

beforeEach(() => {
	dispatched.length = 0
	// the new shell is present, and its start is before these rows, so they are asked.
	;(window as unknown as { BeamioShell?: unknown }).BeamioShell = { postMessage: () => {} }
	localStorage.setItem(RANG_TRACKING_KEY, String(now - 3_600_000))
})

afterEach(() => {
	delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
	delete (window as unknown as { CashTreesAndroid?: unknown }).CashTreesAndroid
})

test('T11: a cancelled incoming call that never rang becomes "missed"', () => {
	const rows = [row('t11')]
	const next = markIncomingCallNeverRang(rows, { callId: 'c-t11', sessionId: 's-t11' })
	expect(next?.[0]).toMatchObject({ status: 'missed', endedAt: now - 50_000, direction: 'incoming' })
})

test("the caller's side and other outcomes are never changed", () => {
	expect(markIncomingCallNeverRang([row('o1', { direction: 'outgoing' })], { sessionId: 's-o1' })).toBeNull()
	expect(markIncomingCallNeverRang([row('o2', { status: 'declined' })], { sessionId: 's-o2' })).toBeNull()
	expect(markIncomingCallNeverRang([row('o3', { status: 'ended' })], { sessionId: 's-o3' })).toBeNull()
	expect(markIncomingCallNeverRang([row('o4')], { sessionId: 'unknown' })).toBeNull()
})

test('a call the shell answered is not marked missed', () => {
	noteNativeCallAnswered('c-ans', 's-ans', now - 55_000)
	expect(markIncomingCallNeverRang([row('ans')], { sessionId: 's-ans' })).toBeNull()
})

test('each incoming cancelled row is asked about once, with createdAt in ms', () => {
	const rows = [
		row('q1'),
		row('q2', { createdAt: Math.floor((now - 120_000) / 1000) }), // seconds
		row('q3', { direction: 'outgoing' }),
		row('q4', { status: 'ringing' }),
		row('q5', { createdAt: now - 4 * 24 * 60 * 60_000 }), // older than the shell keeps
	]
	const first = takeIncomingCallsToAskRang(rows, now)
	expect(first.map(c => c.sessionId)).toEqual(['s-q1', 's-q2'])
	expect(first[1].createdAt).toBe(Math.floor((now - 120_000) / 1000) * 1000)
	expect(takeIncomingCallsToAskRang(rows, now)).toEqual([])
})

test('the query goes to the shell as queryIncomingCallOutcome', () => {
	expect(askShellWhichIncomingCallsRang([row('d1'), row('d2')])).toBe(2)
	expect(dispatched).toHaveLength(1)
	expect(dispatched[0].action).toBe('queryIncomingCallOutcome')
	expect((dispatched[0].payload.calls as unknown[]).length).toBe(2)
	expect(askShellWhichIncomingCallsRang([row('d1')])).toBe(0)
	expect(dispatched).toHaveLength(1)
})

test('a redelivered caller end keeps "missed"; a call that rang stays "cancelled"', () => {
	// Only the shell's "never rang" answer is final; a late-offer guess is not.
	const missed = row('r1', { status: 'missed', neverRang: true })
	expect(phoneCallStatusForPeerHangup(missed)).toBe('missed')
	expect(phoneCallStatusForPeerHangup(row('r3', { status: 'missed' }))).toBe('cancelled')
	expect(mergePhoneCallRecord(missed, { ...missed, status: phoneCallStatusForPeerHangup(missed) })?.status).toBe('missed')
	expect(phoneCallStatusForPeerHangup(row('r2', { status: 'ringing' }))).toBe('cancelled')
})

describe('only calls created after the tracking start are asked (new shell)', () => {
	it('a call created before the tracking start is not asked and not marked, so a later start can still ask it', () => {
		localStorage.setItem(RANG_TRACKING_KEY, String(now - 30_000))
		expect(takeIncomingCallsToAskRang([row('k1')], now)).toEqual([])
		localStorage.setItem(RANG_TRACKING_KEY, String(now - 120_000))
		expect(takeIncomingCallsToAskRang([row('k1')], now).map((c) => c.sessionId)).toEqual(['s-k1'])
	})

	it('no shell and no stored start: nothing is asked and nothing is recorded', () => {
		localStorage.removeItem(RANG_TRACKING_KEY)
		delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
		expect(askShellWhichIncomingCallsRang([row('k2')])).toBe(0)
		expect(dispatched).toHaveLength(0)
		expect(localStorage.getItem(RANG_TRACKING_KEY)).toBeNull()
	})

	it('the first sight of the shell records the start; a later check keeps it', () => {
		localStorage.removeItem(RANG_TRACKING_KEY)
		;(window as unknown as { BeamioShell?: unknown }).BeamioShell = { postMessage: () => {} }
		try {
			// The start is first sight + 5 minutes; a call created after it is asked.
			expect(askShellWhichIncomingCallsRang([row('k3', { createdAt: Date.now() + 10 * 60_000 })])).toBe(1)
			const recorded = Number(localStorage.getItem(RANG_TRACKING_KEY))
			expect(recorded - Date.now()).toBeGreaterThan(4 * 60_000)
			expect(recorded - Date.now()).toBeLessThanOrEqual(5 * 60_000)
			expect(askShellWhichIncomingCallsRang([row('k4', { createdAt: Date.now() + 10 * 60_000 })])).toBe(1)
			expect(Number(localStorage.getItem(RANG_TRACKING_KEY))).toBe(recorded)
		} finally {
			delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
		}
	})
})

describe('the start is first sight + 5 minutes, and the old Android shell asks every call', () => {
	it('a call created before first sight + 5 minutes is not asked; one after it is', () => {
		localStorage.removeItem(RANG_TRACKING_KEY)
		expect(askShellWhichIncomingCallsRang([row('k6', { createdAt: Date.now() - 60_000 })])).toBe(0)
		expect(askShellWhichIncomingCallsRang([row('k7', { createdAt: Date.now() + 10 * 60_000 })])).toBe(1)
	})

	it('an old Android shell (queryIncomingCallOutcome, no BeamioShell) asks every call, even one from before any start', () => {
		delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
		;(window as unknown as { CashTreesAndroid?: unknown }).CashTreesAndroid = { queryIncomingCallOutcome: () => {} }
		localStorage.setItem(RANG_TRACKING_KEY, String(now - 30_000))
		expect(askShellWhichIncomingCallsRang([row('k8')])).toBe(1)
		expect(dispatched.map((d) => d.action)).toEqual(['queryIncomingCallOutcome'])
	})

	it('with no shell that can answer (iOS, browser), nothing is asked even with a stored start', () => {
		delete (window as unknown as { BeamioShell?: unknown }).BeamioShell
		localStorage.setItem(RANG_TRACKING_KEY, String(now - 3_600_000))
		expect(askShellWhichIncomingCallsRang([row('k9')])).toBe(0)
		expect(dispatched).toHaveLength(0)
	})
})

describe('the ids are sent as stored, not trimmed (the shell matches them exactly)', () => {
	it('an id with leading and trailing spaces is sent exactly as stored', () => {
		const out = takeIncomingCallsToAskRang([row('w1', { callId: '  c-w1  ', sessionId: ' s-w1 ' })], now)
		expect(out).toEqual([{ callId: '  c-w1  ', sessionId: ' s-w1 ', createdAt: now - 60_000 }])
		expect(askShellWhichIncomingCallsRang([row('w1x', { callId: '  c-w1x  ', sessionId: ' s-w1x ' })])).toBe(1)
		const calls = (dispatched[0].payload as { calls: Array<{ callId: string; sessionId: string }> }).calls
		expect(calls[0]).toMatchObject({ callId: '  c-w1x  ', sessionId: ' s-w1x ' })
	})

	it('both ids of zero length: the row is not asked', () => {
		expect(takeIncomingCallsToAskRang([row('w3', { callId: '', sessionId: '' })], now)).toEqual([])
	})

	it('a whitespace-only id is a non-empty entry: kept and sent as it is, so the new shell asks it', () => {
		expect(takeIncomingCallsToAskRang([row('w4', { callId: 'c-w4', sessionId: '   ' })], now).map((c) => [c.callId, c.sessionId])).toEqual([['c-w4', '   ']])
		useOldShell()
		expect(takeIncomingCallsToAskRang([row('w4b', { callId: 'c-w4b', sessionId: '   ' })], now).map((c) => [c.callId, c.sessionId])).toEqual([['c-w4b', '   ']])
	})

	it('the exact pair is the de-duplication key: under the old shell, an empty sessionId and a sessionId equal to another callId are both asked', () => {
		useOldShell()
		const out = takeIncomingCallsToAskRang([row('w5', { callId: 'c-x5', sessionId: '' }), row('w6', { callId: 'c-y6', sessionId: 'c-x5' })], now)
		expect(out.map((c) => [c.callId, c.sessionId])).toEqual([['c-x5', ''], ['c-y6', 'c-x5']])
	})
})

describe('the new shell does not ask a row with an empty id; the old shell asks it as stored ', () => {
	it('new shell: an empty sessionId is not asked, so the row keeps its status', () => {
		expect(takeIncomingCallsToAskRang([row('e1', { sessionId: '' })], now)).toEqual([])
		expect(askShellWhichIncomingCallsRang([row('e1b', { sessionId: '' })])).toBe(0)
		expect(dispatched).toHaveLength(0)
	})

	it('new shell: an empty callId is not asked either', () => {
		expect(takeIncomingCallsToAskRang([row('e2', { callId: '' })], now)).toEqual([])
	})

	it('old shell (queryIncomingCallOutcome, no BeamioShell): an empty sessionId or callId is asked as stored', () => {
		useOldShell()
		expect(takeIncomingCallsToAskRang([row('e3', { sessionId: '' })], now).map((c) => [c.callId, c.sessionId])).toEqual([['c-e3', '']])
		expect(takeIncomingCallsToAskRang([row('e4', { callId: '' })], now).map((c) => [c.callId, c.sessionId])).toEqual([['', 's-e4']])
	})
})

describe('a row keeps the ids as the shell sent them', () => {
	it('merging a row keeps a sessionId with spaces exactly (no trim), so a later ask sends it as stored', () => {
		const current = row('k910a', { callId: 'c-k910a', sessionId: 's-k910a' })
		const merged = mergePhoneCallRecord(current, row('k910a', { callId: 'c-k910a', sessionId: ' s-k910a ' }))
		expect(merged).not.toBeNull()
		expect(merged?.sessionId).toBe(' s-k910a ')
	})

	it('an empty sessionId in the row is not asked by the new shell, so an unknown original value stays cancelled', () => {
		expect(takeIncomingCallsToAskRang([row('k910b', { sessionId: '' })], now)).toEqual([])
	})
})

describe('a missing id is stored as empty; a whitespace-only id is kept as it is', () => {
	it('replacePhoneCallInRows keeps a whitespace-only callId as it is, and the sessionId', () => {
		const out = replacePhoneCallInRows([], row('c2a', { callId: '  ', sessionId: 's-c2a' }))
		expect(out[0]).toMatchObject({ callId: '  ', sessionId: 's-c2a' })
	})

	it('mergePhoneCallRecord with no current row keeps a whitespace-only sessionId as it is', () => {
		const merged = mergePhoneCallRecord(null, row('c2b', { callId: 'c-c2b', sessionId: '\t' }))
		expect(merged).toMatchObject({ callId: 'c-c2b', sessionId: '\t' })
	})

	it('mergePhoneCallRecord stores a zero-length id as empty', () => {
		const merged = mergePhoneCallRecord(null, row('c2d', { callId: '', sessionId: 's-c2d' }))
		expect(merged).toMatchObject({ callId: '', sessionId: 's-c2d' })
	})

	it('mergePhoneCallRecord with a zero-length incoming id keeps the current id', () => {
		const merged = mergePhoneCallRecord(row('c2e', { callId: 'c-c2e', sessionId: 's-c2e' }), row('c2e', { callId: '', sessionId: 's-c2e' }))
		expect(merged).toMatchObject({ callId: 'c-c2e', sessionId: 's-c2e' })
	})

	it('mergePhoneCallRecord with a whitespace-only incoming callId stores it as it is (non-empty; the merge result is for the to confirm)', () => {
		const merged = mergePhoneCallRecord(row('c2c', { callId: 'c-c2c', sessionId: 's-c2c' }), row('c2c', { callId: '  ', sessionId: 's-c2c' }))
		expect(merged).toMatchObject({ callId: '  ', sessionId: 's-c2c' })
	})
})

describe('-: call ids match exactly; a missing id never matches', () => {
	it('sameCallId: both sides non-empty and equal; no trim, so " c1" is not "c1"', () => {
		expect(sameCallId(' c1', 'c1')).toBe(false)
		expect(sameCallId('c1', ' c1')).toBe(false)
		expect(sameCallId('c1', 'c1')).toBe(true)
		expect(sameCallId('  ', '  ')).toBe(true)
		expect(sameCallId('', '')).toBe(false)
		expect(sameCallId('', 'c1')).toBe(false)
		expect(sameCallId(undefined, undefined)).toBe(false)
	})

	it('phoneCallIdsOverlap and findPhoneCallByIds use the same exact match', () => {
		expect(phoneCallIdsOverlap({ callId: ' c1' }, { callId: 'c1' })).toBe(false)
		expect(phoneCallIdsOverlap({ callId: 'c1', sessionId: 's1' }, { callId: 'c2', sessionId: 's1' })).toBe(true)
		const rows = [row('c3a', { callId: ' c1', sessionId: 's-c3a' })]
		expect(findPhoneCallByIds(rows, { callId: 'c1' })).toBeUndefined()
		expect(findPhoneCallByIds(rows, { callId: ' c1' })).toBe(rows[0])
		expect(findPhoneCallByIds(rows, { sessionId: '' })).toBeUndefined()
	})

	it('two rows with empty ids do not replace each other', () => {
		const out = replacePhoneCallInRows([row('c3b', { callId: '', sessionId: '' })], row('c3c', { callId: '', sessionId: '' }))
		expect(out).toHaveLength(2)
	})
})
