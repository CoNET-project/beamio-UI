/**
 * Call capability of the running client.
 *
 * A PWA running in an old iOS/Android shell lacks the 0.53.42 call ability (offer/accept v4, voiceCallV4* bridge commands).
 * It must say so and must not start or answer an incompatible call. The state separates four cases plus the browser, so a
 * loading or failed read is never reported as an old shell, and never lets a call through.
 *
 * Pure: the environment and the hello probe answer are passed in. The native reply is read by the caller.
 */

/** The capability the shell declares in its hello ack when it has the 0.53.42 call ability. */
// Named by the interface seat; declared by both SDKs in capabilities.
export const VOICE_CALL_V4_CAPABILITY = 'voiceCallV4'

export type CallCapabilityState =
	/** Not a shell: a plain browser. Its own flow; no prompt. */
	| 'browser'
	/** A shell whose hello answer is not in yet. No prompt; calls refused until it settles (fail closed). */
	| 'loading'
	/** A shell whose latest hello is valid and declares voiceCallV4. Calls allowed. Never cached: each probe decides. */
	| 'compatible'
	/** Every other shell result: no valid hello with voiceCallV4 (missing, refused, unanswered, timed out, malformed or unreadable).
	 * Treated as an old version: the update prompt, calls refused. */
	| 'old_shell'

export type HelloProbe = 'pending' | 'failed' | { answered: boolean; capabilities: readonly string[] | null | undefined; nativeApp?: unknown }

/** The hello reply timeout (the same 10 s as the shell command acknowledgement). A hello still pending past it is `failed`. */
export const HELLO_TIMEOUT_MS = 10_000

/**
 * Settles a hello request: its answer, or `failed` on error or after `timeoutMs`. Never waits forever, so a pending hello becomes
 * old_shell (the same as any other non-compatible result) once the timeout passes.
 */
export async function settleHello(
	hello: Promise<unknown>,
	timeoutMs: number = HELLO_TIMEOUT_MS,
): Promise<HelloProbe> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'failed'>((resolve) => {
		timer = setTimeout(() => resolve('failed'), timeoutMs)
	})
	try {
		const answer = await Promise.race([hello.then(shapeOfHello).catch(() => 'failed' as const), timeout])
		return answer
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/**
 * A malformed hello (not an object, `answered` not a boolean, or `capabilities` present but not an array) settles as `failed`
 * A missing `capabilities` is read as none.
 */
export function shapeOfHello(raw: unknown): HelloProbe {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'failed'
	const r = raw as { answered?: unknown; capabilities?: unknown; nativeApp?: unknown }
	if (typeof r.answered !== 'boolean') return 'failed'
	if (r.capabilities !== undefined && r.capabilities !== null && !Array.isArray(r.capabilities)) return 'failed'
	return { answered: r.answered, capabilities: Array.isArray(r.capabilities) ? r.capabilities : [], nativeApp: r.nativeApp }
}

/** Capabilities as a clean list: a missing, null or non-array value is none; only non-empty strings count. */
export function normalizeCapabilities(raw: readonly unknown[] | null | undefined): string[] {
	if (!Array.isArray(raw)) return []
	return raw.filter((c): c is string => typeof c === 'string' && c.length > 0)
}

/** The version format the native shell must report. */
export const NATIVE_APP_VERSION_RE = /^\d+(\.\d+){1,3}$/
export const NATIVE_APP_BUILD_RE = /^\d+$/

/**
 * The native app of the hello ack, when valid: platform ios or android, version and build in the given formats. Anything else
 * (missing, empty, wrong type, wrong format) is null. The PWA ZIP, SDK or cached version never stands in for it.
 */
export function validNativeApp(raw: unknown): { platform: 'ios' | 'android'; version: string; build: string } | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const r = raw as { platform?: unknown; version?: unknown; build?: unknown }
	if (r.platform !== 'ios' && r.platform !== 'android') return null
	if (typeof r.version !== 'string' || !NATIVE_APP_VERSION_RE.test(r.version)) return null
	if (typeof r.build !== 'string' || !NATIVE_APP_BUILD_RE.test(r.build)) return null
	return { platform: r.platform, version: r.version, build: r.build }
}

/**
 * The state from the environment and the latest hello probe:
 * - not a shell: browser (its own flow, no prompt);
 * - shell, probe pending: loading (no prompt, no call);
 * - shell, compatible only when the hello is valid AND carries a valid nativeApp AND declares voiceCallV4;
 * - shell, anything else (no voiceCallV4, no or invalid nativeApp, unanswered, timed out, refused, malformed, unreadable): old_shell.
 * Only four states. No version threshold, no retry, no third class.
 */
export function callCapabilityStateOf(input: { inShell: boolean; probe: HelloProbe }): CallCapabilityState {
	if (!input.inShell) return 'browser'
	if (input.probe === 'pending') return 'loading'
	if (input.probe === 'failed') return 'old_shell'
	if (!input.probe.answered) return 'old_shell'
	const hasV4 = normalizeCapabilities(input.probe.capabilities).includes(VOICE_CALL_V4_CAPABILITY)
	return hasV4 && validNativeApp(input.probe.nativeApp) !== null ? 'compatible' : 'old_shell'
}

/** A call may be started or answered only in the browser or a compatible shell. Every other state refuses it. */
export function callAllowed(state: CallCapabilityState): boolean {
	return state === 'browser' || state === 'compatible'
}

/**
 * The locale key of the update prompt for a surface, or null. Only old_shell shows it (the chat banner and the incoming window).
 */
export function callUpgradePromptKey(state: CallCapabilityState, surface: 'chat' | 'incoming'): string | null {
	if (state !== 'old_shell') return null
	return surface === 'chat' ? 'call.upgrade.chat' : 'call.upgrade.incoming'
}
