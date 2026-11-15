/**
 * "Did this incoming call ring?"(queryIncomingCallOutcome). Which calls the page asks depends on the shell:
 *
 * - New shell (window.BeamioShell present): it pairs a call with its ringing record by exact callId and sessionId. A call from
 *   before the shell started recording has no exact pair and would read as "did not ring", so only calls created after the tracking
 *   start are asked. The start is the moment the page first sees window.BeamioShell plus RANG_TRACKING_MARGIN_MS (5 minutes), to absorb
 *   the clock difference between the caller and this phone. It is stored in localStorage and kept (it survives reloads and updates).
 * - Old Android shell (CashTreesAndroid.queryIncomingCallOutcome present, no BeamioShell): it keeps one ringing record per id, so every
 *   call is asked, as before. No start is applied to it.
 * - Anything else (iOS, browser): nothing is asked; the shell has no such query.
 */
import { hasBeamioShell } from './beamioShellChannel'

export const RANG_TRACKING_KEY = 'beamio.incomingRing.trackingSince.v1'

/** the start is first sight + this margin, to absorb the clock difference between the caller and this phone. */
export const RANG_TRACKING_MARGIN_MS = 5 * 60_000

/** The stored tracking start (ms), or null when none has been recorded on this device. */
export function rangTrackingSince(): number | null {
	try {
		const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(RANG_TRACKING_KEY)
		if (!raw) return null
		const n = Number(raw)
		return Number.isFinite(n) && n > 0 ? n : null
	} catch {
		return null
	}
}

/**
 * Records the start the first time the new shell is seen: first sight + RANG_TRACKING_MARGIN_MS. Keeps the first value afterwards.
 * Returns the stored start, or null when the new shell has not been seen (nothing is recorded then).
 */
export function ensureRangTracking(now: number = Date.now(), shell: boolean = hasBeamioShell()): number | null {
	const existing = rangTrackingSince()
	if (existing !== null) return existing
	if (!shell) return null
	const start = now + RANG_TRACKING_MARGIN_MS
	try {
		localStorage.setItem(RANG_TRACKING_KEY, String(start))
	} catch {
		return null
	}
	return start
}

/** The old Android shell: CashTreesAndroid.queryIncomingCallOutcome is present. */
export function legacyAndroidRingQuery(): boolean {
	if (typeof window === 'undefined') return false
	const android = (window as unknown as { CashTreesAndroid?: { queryIncomingCallOutcome?: unknown } }).CashTreesAndroid
	return typeof android?.queryIncomingCallOutcome === 'function'
}

export type RingAskMode = { mode: 'none' } | { mode: 'all' } | { mode: 'since'; since: number }

/** Which calls the page asks now: see the header. The new shell wins when both are present. */
export function ringAskMode(now: number = Date.now()): RingAskMode {
	if (hasBeamioShell()) {
		const since = ensureRangTracking(now, true)
		return since === null ? { mode: 'none' } : { mode: 'since', since }
	}
	return legacyAndroidRingQuery() ? { mode: 'all' } : { mode: 'none' }
}
