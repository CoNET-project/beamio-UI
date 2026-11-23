/**
 * Report of the boot-time WebSocket refusal probe (R84 item 1).
 *
 * The production build strips console calls (craco.config.js: drop_console), so a report written only with console.error never
 * reaches the artifact's users. The result is therefore kept on a global that the page and the testers can read, and a failure is
 * sent through publishNativePwaLog (the native debug log in the shells). The build check (scripts/check-ws-guard-build.js) requires
 * both the report text and the global to survive the minifier.
 */
import type { WebSocketProbeResult } from './webSocketGuard'

/** Global holding the last probe result: 'refused' | 'not_guarded' | 'other'. */
export const WS_PROBE_GLOBAL = '__beamioWsProbe'

/** Text of the failure report (kept verbatim: the build check looks for it). */
export const WS_GUARD_REPORT = '[ws-guard] WebSocket refusal is not the project guard'

type ReportScope = Record<string, unknown>

/**
 * Records the probe result on the global and reports a failure through `log`. A 'refused' result is recorded and not reported.
 */
export function reportWebSocketProbe(
	probe: WebSocketProbeResult,
	log: (level: 'error', message: string) => void,
	scope: ReportScope = globalThis as unknown as ReportScope,
): void {
	scope[WS_PROBE_GLOBAL] = probe
	if (probe !== 'refused') log('error', `${WS_GUARD_REPORT} (probe=${probe})`)
}
