/**
 * R84 item 1: the probe report is kept on a global and sent to the native log, not only to console (console is stripped in production).
 */
import { reportWebSocketProbe, WS_GUARD_REPORT, WS_PROBE_GLOBAL } from './webSocketProbeReport'

describe('WebSocket probe report (R84 item 1)', () => {
	it('a refused probe is recorded on the global and reports nothing', () => {
		const scope: Record<string, unknown> = {}
		const log = jest.fn()
		reportWebSocketProbe('refused', log, scope)
		expect(scope[WS_PROBE_GLOBAL]).toBe('refused')
		expect(log).not.toHaveBeenCalled()
	})

	it.each(['not_guarded', 'other'] as const)('a %s probe is recorded and reported through the native log channel', (probe) => {
		const scope: Record<string, unknown> = {}
		const log = jest.fn()
		reportWebSocketProbe(probe, log, scope)
		expect(scope[WS_PROBE_GLOBAL]).toBe(probe)
		expect(log).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledWith('error', `${WS_GUARD_REPORT} (probe=${probe})`)
	})

	it('the report text is the one the build check looks for', () => {
		expect(WS_GUARD_REPORT).toBe('[ws-guard] WebSocket refusal is not the project guard')
		expect(WS_PROBE_GLOBAL).toBe('__beamioWsProbe')
	})
})
