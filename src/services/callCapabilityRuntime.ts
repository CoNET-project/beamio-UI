/**
 * Runtime of the call capability state (the decision, 2026-11-21). One hello probe per start in a shell, settled by
 * callCapabilityStateOf: only a valid hello with voiceCallV4 is compatible; every other shell result is old_shell. A plain browser
 * is never probed and keeps its own flow. A bridge failure is written to the diagnostic log only.
 */
import { callCapabilityStateOf, settleHello, HELLO_TIMEOUT_MS, type CallCapabilityState, type HelloProbe } from './callCapability'
import { probeNativeCapabilities } from './nativeChatRouteRegister'
import { publishNativePwaLog } from '../utils/cashTreesNativePwaLog'
import { isCashTreesNativeWebView } from '../utils/cashTreesNativeNfc'

type Listener = () => void
// A shell starts in loading (no Accept, no call) until the single startup probe settles; a plain browser starts in browser.
let state: CallCapabilityState = isCashTreesNativeWebView() ? 'loading' : 'browser'
const listeners = new Set<Listener>()
let started = false
let inShellFlag = false

/**
 * Probe sequencing (review): every probe takes an increasing number; only the newest started probe writes the global
 * state, so an older late success can never overwrite a newer failure. A dial or answer decides on its own probe's result.
 */
export class ProbeSequencer {
	private latest = 0
	next(): number {
		this.latest += 1
		return this.latest
	}
	/** True only for the newest started probe. */
	isLatest(seq: number): boolean {
		return seq === this.latest
	}
}
const sequencer = new ProbeSequencer()

export const getCallCapabilityState = (): CallCapabilityState => state
export const subscribeCallCapabilityState = (listener: Listener): (() => void) => {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
const setState = (next: CallCapabilityState) => {
	if (next === state) return
	state = next
	listeners.forEach((l) => l())
}

function runProbe(): void {
	if (!inShellFlag) {
		setState('browser')
		return
	}
	setState('loading')
	const seq = sequencer.next()
	void settleHello(probeNativeCapabilities(HELLO_TIMEOUT_MS), HELLO_TIMEOUT_MS).then((probe) => {
		if (!sequencer.isLatest(seq)) return
		if (probe === 'failed' || (typeof probe === 'object' && !probe.answered)) {
			publishNativePwaLog('warn', '[callCapability] hello not answered validly: old_shell (update prompt)')
		}
		setState(callCapabilityStateOf({ inShell: true, probe }))
	})
}

/** Starts the probe once. `inShell` comes from the caller (the native webview check). */
export function startCallCapabilityProbe(inShell: boolean): void {
	if (started) return
	started = true
	inShellFlag = inShell
	runProbe()
}

// The state shown in the UI is refreshed by the probe at start and by each dial or answer.

/** Probes again (no new bridge command). The latest result replaces the previous one. */
export function retryCallCapabilityProbe(): void {
	if (!started) return
	runProbe()
}

/**
 * A fresh probe for one dial or one answer (the decision): compatible is never kept between calls. It runs the hello now (10 s
 * bound), sets the state, and returns it. A browser returns browser without a probe.
 */
export async function probeCallCapabilityNow(): Promise<CallCapabilityState> {
	if (!inShellFlag) {
		setState('browser')
		return 'browser'
	}
	setState('loading')
	const seq = sequencer.next()
	const probe: HelloProbe = await settleHello(probeNativeCapabilities(HELLO_TIMEOUT_MS), HELLO_TIMEOUT_MS)
	if (probe === 'failed' || (typeof probe === 'object' && !probe.answered)) {
		publishNativePwaLog('warn', '[callCapability] fresh hello not answered validly: old_shell (update prompt)')
	}
	const own = callCapabilityStateOf({ inShell: true, probe })
	// Only the newest started probe writes the shared state; this call still decides on its own result.
	if (sequencer.isLatest(seq)) setState(own)
	return own
}
