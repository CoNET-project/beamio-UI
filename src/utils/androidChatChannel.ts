/**
 * Android chat channel. When the page finds `window.BeamioChat`, the chat module uses it; otherwise it keeps the legacy
 * `CashTreesAndroid` methods. iOS is not touched here.
 *
 * - Command: `BeamioChat.postMessage(JSON.stringify(cmd))`, with the same `cmd` as `CashTreesAndroid.chatModuleCommand`.
 * - Sign response: `BeamioChat.postMessage(JSON.stringify({type: "chatModuleSignResponse", reqId, ok, signature?, error?}))`.
 * It is a JSON string like the command; the shell answers `bad_request`to any non-string message ( /).
 * - Replies and events: the shell calls `BeamioChat.onmessage` with a JSON string. The parsed object is the same `detail` that the
 *   `cashtreesandroid` event carries (`chatModuleEvent`, `chatModuleSignRequest`), so the existing listeners are reused.
 * - `origin_refused` (the shell's origin check) is a failure. Only the code is logged.
 */
import { publishNativePwaLog } from './cashTreesNativePwaLog'
import { getAndroidChatHost } from './cashTreesAndroidConetChat'

/** The answer code of the shell's origin check on the new channel (a failure). */
export const ORIGIN_REFUSED_CODE = 'origin_refused'

/** The event name the existing chat listeners use on the Android shell. */
export const ANDROID_CHAT_EVENT = 'cashtreesandroid'

type BeamioChatHost = {
	postMessage?: (msg: unknown) => void
	onmessage?: ((ev: unknown) => void) | null
}

/** The new channel object, when the shell injected it. */
export function beamioChatHost(): BeamioChatHost | null {
	if (typeof window === 'undefined') return null
	const host = (window as unknown as { BeamioChat?: unknown }).BeamioChat
	return host && typeof host === 'object' ? (host as BeamioChatHost) : null
}

/** Which Android channel this page uses. `none` when the shell has neither. */
export function androidChatChannelKind(): 'beamio' | 'legacy' | 'none' {
	if (beamioChatHost()) return 'beamio'
	const legacy = getAndroidChatHost() as { chatModuleCommand?: unknown } | null
	return legacy && typeof legacy.chatModuleCommand === 'function' ? 'legacy' : 'none'
}

/**
 * True when the Android chat module is present through either channel (window.BeamioChat or the legacy chatModuleCommand).
 * Presence is all this decides. Whether the module is running is still asked of the legacy host (chatModuleIsRunning): the new
 * channel has no such query in the contract.
 */
export function androidChatModulePresent(): boolean {
	return androidChatChannelKind() !== 'none'
}

/** Sends one chat-module command. False when the channel cannot take it. */
export function postAndroidChatCommand(cmd: Record<string, unknown>): boolean {
	const host = beamioChatHost()
	if (host) {
		if (typeof host.postMessage !== 'function') return false
		try {
			host.postMessage(JSON.stringify(cmd))
			return true
		} catch {
			return false
		}
	}
	const legacy = getAndroidChatHost() as (Record<string, unknown> & { chatModuleCommand?: unknown }) | null
	if (legacy && typeof legacy.chatModuleCommand === 'function') {
		// Reflect.apply: never detach a Java bridge method from its host (Illegal invocation).
		Reflect.apply(legacy.chatModuleCommand as (...a: unknown[]) => unknown, legacy, [JSON.stringify(cmd)])
		return true
	}
	return false
}

/** Sends the signature answer for a sign request. False when the channel cannot take it. */
export function postAndroidSignResponse(payload: Record<string, unknown>): boolean {
	const host = beamioChatHost()
	if (host) {
		if (typeof host.postMessage !== 'function') return false
		try {
			host.postMessage(JSON.stringify({ type: 'chatModuleSignResponse', ...payload }))
			return true
		} catch {
			return false
		}
	}
	const legacy = getAndroidChatHost() as (Record<string, unknown> & { chatModuleSignResponse?: unknown }) | null
	if (legacy && typeof legacy.chatModuleSignResponse === 'function') {
		Reflect.apply(legacy.chatModuleSignResponse as (...a: unknown[]) => unknown, legacy, [JSON.stringify(payload)])
		return true
	}
	return false
}

/** True for an answer that is a failure on this channel: any refused ack, and `origin_refused` in particular. */
export function isChatChannelFailure(data: unknown): boolean {
	if (!data || typeof data !== 'object') return false
	const d = data as { type?: unknown; ok?: unknown; error?: unknown }
	if (d.type !== 'ack') return false
	return d.ok !== true || d.error === ORIGIN_REFUSED_CODE
}

/**
 * Receives the new channel's messages. Installed once at start; a no-op without `window.BeamioChat`. A message that is not a JSON
 * object is dropped. Every other message is dispatched as the `cashtreesandroid` event, so the existing listeners handle it.
 */
export function installBeamioChatReceiver(): (() => void) | null {
	const host = beamioChatHost()
	if (!host) return null
	const handler = (ev: unknown) => {
		const raw = (ev as { data?: unknown } | null)?.data ?? ev
		let detail: unknown = raw
		if (typeof raw === 'string') {
			try {
				detail = JSON.parse(raw)
			} catch {
				return
			}
		}
		if (!detail || typeof detail !== 'object') return
		if (isChatChannelFailure(detail)) {
			// Only the code is logged, never the payload.
			const code = (detail as { error?: unknown }).error
			publishNativePwaLog('info', `[chatChannel] answer refused: ${typeof code === 'string' ? code : 'not_ok'}`)
		}
		window.dispatchEvent(new CustomEvent(ANDROID_CHAT_EVENT, { detail }))
	}
	const previous = host.onmessage ?? null
	host.onmessage = handler
	return () => {
		if (host.onmessage === handler) host.onmessage = previous
	}
}
