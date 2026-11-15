/**
 * "Did it ring"asking: the tracking start for the new shell, and which calls are asked for each shell.
 * SYNTHETIC values only.
 */
import { RANG_TRACKING_KEY, RANG_TRACKING_MARGIN_MS, ensureRangTracking, legacyAndroidRingQuery, rangTrackingSince, ringAskMode } from './incomingRangTracking'

const win = window as unknown as { BeamioShell?: unknown; CashTreesAndroid?: unknown }

afterEach(() => {
	localStorage.clear()
	delete win.BeamioShell
	delete win.CashTreesAndroid
})

describe('the tracking start for the new shell', () => {
	it('no shell and nothing stored: nothing is recorded and there is no start', () => {
		expect(ensureRangTracking(1_000)).toBeNull()
		expect(rangTrackingSince()).toBeNull()
		expect(localStorage.getItem(RANG_TRACKING_KEY)).toBeNull()
	})

	it('the first sight records first sight + 5 minutes; a later call keeps the first value', () => {
		expect(RANG_TRACKING_MARGIN_MS).toBe(5 * 60_000)
		expect(ensureRangTracking(5_000, true)).toBe(5_000 + RANG_TRACKING_MARGIN_MS)
		expect(ensureRangTracking(9_000, true)).toBe(5_000 + RANG_TRACKING_MARGIN_MS)
		expect(rangTrackingSince()).toBe(5_000 + RANG_TRACKING_MARGIN_MS)
	})

	it('the stored start survives a reload (read again from storage)', () => {
		localStorage.setItem(RANG_TRACKING_KEY, '7000')
		expect(rangTrackingSince()).toBe(7000)
		expect(ensureRangTracking(9_000, false)).toBe(7000)
	})

	it('an invalid stored value is ignored; with the new shell it is replaced by first sight + 5 minutes', () => {
		localStorage.setItem(RANG_TRACKING_KEY, 'not-a-number')
		expect(rangTrackingSince()).toBeNull()
		expect(ensureRangTracking(3_000, true)).toBe(3_000 + RANG_TRACKING_MARGIN_MS)
	})
})

describe('which calls are asked, by shell', () => {
	it('the new shell asks only after its start (first sight + 5 minutes)', () => {
		win.BeamioShell = { postMessage: () => {} }
		expect(ringAskMode(10_000)).toEqual({ mode: 'since', since: 10_000 + RANG_TRACKING_MARGIN_MS })
	})

	it('an old Android shell asks every call (no start is applied), even with a stored start', () => {
		win.CashTreesAndroid = { queryIncomingCallOutcome: () => {} }
		localStorage.setItem(RANG_TRACKING_KEY, '999999999999')
		expect(legacyAndroidRingQuery()).toBe(true)
		expect(ringAskMode(10_000)).toEqual({ mode: 'all' })
	})

	it('when both are present, the new shell wins', () => {
		win.BeamioShell = { postMessage: () => {} }
		win.CashTreesAndroid = { queryIncomingCallOutcome: () => {} }
		expect(ringAskMode(10_000).mode).toBe('since')
	})

	it('iOS and the browser (no shell, no legacy query): nothing is asked', () => {
		expect(legacyAndroidRingQuery()).toBe(false)
		expect(ringAskMode(10_000)).toEqual({ mode: 'none' })
	})
})
