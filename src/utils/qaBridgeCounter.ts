/**
 * QA-build-only read-only counter of the commands the page sends over the native bridge (dial, signalling, voiceCallV4* and the rest), so a
 * device check can show "zero calls after the tap". It exists only when the build sets REACT_APP_QA_BRIDGE_COUNTER=true. In every other build
 * the guard below is a build-time constant false: no counter, no global, no log. It stores command NAMES only, never a payload.
 */
export function noteBridgeCommand(kind: string, type: unknown): void {
	if (process.env.REACT_APP_QA_BRIDGE_COUNTER !== 'true') return
	const name = typeof type === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(type) ? type : 'other'
	const w = window as unknown as { __beamioQaBridgeCounts?: Record<string, number> }
	const counts = (w.__beamioQaBridgeCounts ??= {})
	const key = `${kind}:${name}`
	counts[key] = (counts[key] ?? 0) + 1
}
