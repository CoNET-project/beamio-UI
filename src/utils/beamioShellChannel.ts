/**
 * Android sensitive methods on `window.BeamioShell`(11).
 *
 * - Page to shell: `BeamioShell.postMessage(JSON.stringify({action, reqId, args}))`. `args` is the object that the legacy method
 * received as its JSON string, or the original object payload. A missing `args` means `{}`.
 * - Shell to page: `BeamioShell.onmessage` gets a JSON string `{type:"ack", action, reqId, ok, result?, error?}`, exactly one per
 * message. Only `queryInstalledApps`, `listInstalledWalletApps` (array of ids) and `startNativeVoiceMic` (boolean) carry a `result`.
 * - Follow-up results (scan, saved file, post result, call events, in-app browser closed, mic data) stay on the `cashtreesandroid`
 * event. The ack only says whether the shell accepted the request, so a page waits for the event where it waits today.
 * - Selection: a page uses `window.BeamioShell` when it is present and falls back to `CashTreesAndroid` only when it is not.
 * iOS never uses this object.
 *
 * Only the error code is logged for a refused ack; the payload is never logged.
 */
import { publishNativePwaLog } from './cashTreesNativePwaLog'

/** The 21 actions of.4:.2's list, minus scanRecoveryQr (deleted), plus notifyVoiceMicReady, queryIncomingCallOutcome, the two ephemeral-key actions and incomingCallUnlockShown. */
export const BEAMIO_SHELL_ACTIONS = [
	'openURL',
	'openInAppBrowser',
	'queryInstalledApps',
	'listInstalledWalletApps',
	'scanQr',
	'saveFile',
	'requestCameraCapture',
	'bindPushIdentity',
	'postPgpCiphertext',
	'setNativeSiNodeRoster',
	'setNativeVoiceRelayNodes',
	'cacheCallerAvatars',
	'prepareSystemCall',
	'cancelPreparedSystemCall',
	'startSystemCall',
	'reportIncomingSystemCall',
	'endSystemCall',
	// Local only (2026-11-20): stop the ring, close the card and notification, clear the record. No uplink, no signature.
	'dismissIncomingSystemCall',
	'startNativeVoiceMic',
	'stopNativeVoiceMic',
	'notifyVoiceMicReady',
	'queryIncomingCallOutcome',
	// Local ephemeral keys for a call (v105 §112, v106 §114): the shell generates and holds the temporary PGP key and wallet;
	// only the public channel fields come back. Prepare: {role, sid, needPgp} -> {ok, channel:{sid,key,wk,temp,tempPgpFpr,tempPgpArmor?}}.
	// Errors not_ready | keygen_failed | bad_request | timeout (10 s, one retry at most). Forget drops the call's keys.
	'voiceEphemeralPrepare',
	'voiceEphemeralForget',
	// Page to shell (decision): sent when the incoming-call unlock entry becomes interactive. Payload {callId}.
	'incomingCallUnlockShown',
] as const

export type BeamioShellAction = (typeof BEAMIO_SHELL_ACTIONS)[number]

/**
 * 0.53.49 (page-input recovery, Android shell 348e941a): three more actions on this channel, kept apart from the 21 above. `nativeRecoverySubmit`
 * takes exactly {path:"code", code} or {path:"account", name, password}; `nativeRecoveryCancel` takes no args; `shellCapabilities` takes no args and
 * answers {capabilities:[...]} (an old shell answers unknown_command). 0.53.50 (page-side onboarding create): `accountCreateRegister` takes exactly
 * {tag, password} and answers the SDK result in `result`; `secureScreen` takes {on}. No args are logged here or anywhere on the page.
 */
export const BEAMIO_SHELL_RECOVERY_ACTIONS = ['nativeRecoverySubmit', 'nativeRecoveryCancel', 'shellCapabilities', 'accountCreateRegister', 'secureScreen'] as const
export type BeamioShellRecoveryAction = (typeof BEAMIO_SHELL_RECOVERY_ACTIONS)[number]

/** The shell's answer. `error` is a code (for example `origin_refused`, `bad_args`, `not_ready`, `not_supported`), never a value. */
export type BeamioShellAck = { ok: true; result?: unknown } | { ok: false; error: string }

/** Local codes that are not shell answers. */
export const SHELL_TIMEOUT = 'timeout'
export const SHELL_NOT_SUPPORTED = 'not_supported'
export const SHELL_BRIDGE_MISSING = 'bridge_missing'

/** Reply timeout of one request. Follow-up results are not waited for here. */
const ACK_TIMEOUT_MS = 10_000

/** Request ids for this channel. Distinct from the other channels' ranges. */
const REQ_BASE = 810_000_000
let reqSeq = 0
const nextReqId = (): number => {
	reqSeq += 1
	return REQ_BASE + reqSeq
}

type ShellHost = {
	postMessage?: (msg: unknown) => void
	onmessage?: ((ev: unknown) => void) | null
}

/** The injected `window.BeamioShell`, when the shell has put it in place. */
export function beamioShellHost(): ShellHost | null {
	if (typeof window === 'undefined') return null
	const host = (window as unknown as { BeamioShell?: unknown }).BeamioShell
	if (!host || typeof host !== 'object') return null
	return typeof (host as ShellHost).postMessage === 'function' ? (host as ShellHost) : null
}

/** True when the shell provides the new channel. The page then never calls the legacy method for these actions. */
export function hasBeamioShell(): boolean {
	return beamioShellHost() !== null
}

/** Ack waiters, by reqId. A fire-and-forget entry only logs a refusal code. */
const pending = new Map<number, (ack: BeamioShellAck) => void>()

/**
 * Sends one action and resolves with its ack. A refusal, an unknown answer or a timeout resolves with `ok:false`; it never throws.
 * Without `window.BeamioShell` it resolves `not_supported` at once and sends nothing.
 */
export function requestBeamioShell(
	action: BeamioShellAction | BeamioShellRecoveryAction,
	args: Record<string, unknown> = {},
	timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<BeamioShellAck> {
	const host = beamioShellHost()
	if (!host) return Promise.resolve({ ok: false, error: SHELL_NOT_SUPPORTED })
	const reqId = nextReqId()
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(reqId)
			resolve({ ok: false, error: SHELL_TIMEOUT })
		}, timeoutMs)
		pending.set(reqId, (ack) => {
			clearTimeout(timer)
			resolve(ack)
		})
		try {
			host.postMessage!(JSON.stringify({ action, reqId, args }))
		} catch {
			clearTimeout(timer)
			pending.delete(reqId)
			resolve({ ok: false, error: SHELL_BRIDGE_MISSING })
		}
	})
}

/**
 * Fire-and-forget: the page does not wait for the answer. Returns false only when the message could not be posted (no shell, or the
 * call threw). A refusal that arrives later is logged by code only.
 */
export function postBeamioShell(
	action: BeamioShellAction,
	args: Record<string, unknown> = {},
	/** Called once when the shell refuses the message (an ack with ok:false). Not called for a timeout. */
	onRefused?: (error: string) => void,
): boolean {
	const host = beamioShellHost()
	if (!host) return false
	const reqId = nextReqId()
	try {
		host.postMessage!(JSON.stringify({ action, reqId, args }))
	} catch {
		return false
	}
	pending.set(reqId, (ack) => {
		if (ack.ok) return
		publishNativePwaLog('info', `[beamioShell] ${action} refused: ${ack.error}`)
		onRefused?.(ack.error)
	})
	setTimeout(() => pending.delete(reqId), ACK_TIMEOUT_MS)
	return true
}

/**
 * Receives the shell's answers. Installed once at start; a no-op without `window.BeamioShell`. A message that is not a JSON string
 * holding an `ack` is dropped; an ack for an unknown reqId is dropped too.
 */
export function installBeamioShellReceiver(): (() => void) | null {
	const host = beamioShellHost()
	if (!host) return null
	const handler = (ev: unknown) => {
		const raw = (ev as { data?: unknown } | null)?.data ?? ev
		if (typeof raw !== 'string') return
		let msg: unknown
		try {
			msg = JSON.parse(raw)
		} catch {
			return
		}
		if (!msg || typeof msg !== 'object') return
		const m = msg as { type?: unknown; reqId?: unknown; ok?: unknown; result?: unknown; error?: unknown; capabilities?: unknown }
		if (m.type !== 'ack' || typeof m.reqId !== 'number') return
		const settle = pending.get(m.reqId)
		if (!settle) return
		pending.delete(m.reqId)
		settle(
			m.ok === true
				? { ok: true, result: m.result !== undefined ? m.result : Array.isArray(m.capabilities) ? { capabilities: m.capabilities } : undefined }
				: { ok: false, error: typeof m.error === 'string' && m.error ? m.error : 'bad_ack' },
		)
	}
	const previous = host.onmessage ?? null
	host.onmessage = handler
	return () => {
		if (host.onmessage === handler) host.onmessage = previous
	}
}
