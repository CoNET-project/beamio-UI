import { isTrustedTopFrame } from './androidChatChannel'

/**
 * The native local hangup (v66 §73, 2026-11-20). The shell reports that its own user hung up a CONNECTED call:
 * `chatModuleEvent` with the inner event `nativeCallHangup {callId, sessionId, reason:"local_hangup", at}`.
 *
 * The page handles it only when (callId, sessionId) match the connected call it holds. Then it ends the call through the one
 * path that sends voice_end_v1 and requests the local endSystemCall (the caller passes `endCall`). Anything else is a no-op:
 * a mismatched handle, a call that is not connected, or a duplicate after the call ended. `at` is never part of the check.
 * Event names are read from the shell's event list (see the chat transports); the command allowlist is not touched.
 */
export type NativeCallHangup = { callId: string; sessionId: string; reason: 'local_hangup'; at?: unknown }

/** A valid inner event, or null. Both handles must be non-empty strings and reason must be `local_hangup`. */
export function parseNativeCallHangup(payload: unknown): NativeCallHangup | null {
	if (!payload || typeof payload !== 'object') return null
	const p = payload as { type?: unknown; callId?: unknown; sessionId?: unknown; reason?: unknown; at?: unknown }
	if (p.type !== 'nativeCallHangup') return null
	if (typeof p.callId !== 'string' || !p.callId.trim()) return null
	if (typeof p.sessionId !== 'string' || !p.sessionId.trim()) return null
	if (p.reason !== 'local_hangup') return null
	return { callId: p.callId.trim(), sessionId: p.sessionId.trim(), reason: 'local_hangup', at: p.at }
}

export type ConnectedCall = { callId: string; sessionId: string; connected: boolean } | null

/**
 * Handles one event. Returns 'ended' when the call was ended by this event, 'noop' otherwise. Pure: the page supplies the current
 * call and the end action.
 */
export function handleNativeCallHangup(
	payload: unknown,
	deps: {
		getCurrent: () => ConnectedCall
		endCall: (callId: string, sessionId: string) => void
	},
): 'ended' | 'noop' {
	const hangup = parseNativeCallHangup(payload)
	if (!hangup) return 'noop'
	const current = deps.getCurrent()
	if (!current || !current.connected) return 'noop'
	if (current.callId !== hangup.callId || current.sessionId !== hangup.sessionId) return 'noop'
	deps.endCall(current.callId, current.sessionId)
	return 'ended'
}

/**
 * The connected call the App ends on a native hang-up. Set by the chat page while a call is connected; the App's watcher uses it
 * even when the chat page is not mounted (the end closure keeps the call's controller alive). Cleared before the end runs, so a
 * duplicate event is a no-op.
 */
export type ConnectedCallEntry = { callId: string; sessionId: string; end: () => void }
let connectedCallEntry: ConnectedCallEntry | null = null
export function setConnectedCall(entry: ConnectedCallEntry | null): void {
	connectedCallEntry = entry
}
export function getConnectedCall(): ConnectedCallEntry | null {
	return connectedCallEntry
}
/** Clears the entry when it is this call (the page's own end). */
export function clearConnectedCallIfMatches(callId: string | undefined, sessionId: string | undefined): void {
	if (connectedCallEntry && connectedCallEntry.callId === callId && connectedCallEntry.sessionId === sessionId) {
		connectedCallEntry = null
	}
}
/** The App's handler: a valid, matching hang-up ends the registered call once. */
export function handleRegisteredNativeCallHangup(payload: unknown): 'ended' | 'noop' {
	return handleNativeCallHangup(payload, {
		getCurrent: () => {
			const entry = connectedCallEntry
			return entry ? { callId: entry.callId, sessionId: entry.sessionId, connected: true } : null
		},
		endCall: () => {
			const entry = connectedCallEntry
			connectedCallEntry = null
			entry?.end()
		},
	})
}

/** The shell's event names (the same as the chat transports). */
const HANGUP_EVENT_NAMES = ['cashtreesios', 'cashtreesandroid'] as const

/** Reads the inner event of a `chatModuleEvent` detail (the same shape as the passcode state watcher). */
function innerEventOf(ev: Event): unknown {
	const detail = (ev as CustomEvent).detail as Record<string, unknown> | undefined
	if (!detail || typeof detail !== 'object' || detail.action !== 'chatModuleEvent') return null
	return detail.event ?? detail.payload ?? null
}

/** Installs the watcher; returns the remover (null without a window). */
export function installNativeCallHangupWatcher(onPayload: (payload: unknown) => void): (() => void) | null {
	if (typeof window === 'undefined') return null
	const listener = (ev: Event) => {
		// Only the trusted top frame (the same guard as the Android chat channel). Other frames and events are ignored.
		if (!isTrustedTopFrame()) return
		const inner = innerEventOf(ev)
		if (inner) onPayload(inner)
	}
	for (const name of HANGUP_EVENT_NAMES) window.addEventListener(name, listener)
	return () => {
		for (const name of HANGUP_EVENT_NAMES) window.removeEventListener(name, listener)
	}
}
