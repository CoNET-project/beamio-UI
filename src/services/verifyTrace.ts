/**
 * QA trace of the first-contact trust path (BCHAT field test, section 36): which call ran, and what it decided.
 *
 * Kept in `window.__beamioVerifyTrace` (a list of short records), only in a build with REACT_APP_BEAMIO_BOOT_TRACE=true. The switch is
 * written inline so a Release build folds the branch away. A record carries an event name, a monotonic time and booleans or counts. It never
 * carries an address, a key, a fingerprint or message text.
 */
export type VerifyTraceEvent =
	| 'verify-confirm'
	| 'trust-write'
	| 'trust-persist'
	| 'held-retry'
	| 'held-rebuild'
	| 'pinned-send'
	| 'trust-readback'
	| 'trust-gate'

export interface VerifyTraceRecord {
	event: VerifyTraceEvent
	t: number
	[field: string]: string | number | boolean
}

const MAX_RECORDS = 200

export function recordVerifyTrace(event: VerifyTraceEvent, fields: Record<string, string | number | boolean> = {}): void {
	if (process.env.REACT_APP_BEAMIO_BOOT_TRACE === 'true') {
		const scope = globalThis as unknown as { __beamioVerifyTrace?: VerifyTraceRecord[] }
		const list = scope.__beamioVerifyTrace ?? []
		list.push({ event, t: Math.round(performance.now()), ...fields })
		if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS)
		scope.__beamioVerifyTrace = list
	}
}
