/**
 * passcodeState from the native shell: the outer `chatModuleEvent` carries `event: {type:'passcodeState', set, locked}`.
 * The native side emits it after a passcode run completes (not on an automatic lock). The page never relies on it to learn that the
 * wallet locked; it uses an unlock (`locked:false`) only to release a
 * held init once and to refresh its hints. A malformed payload is ignored.
 */
/** The shell's event names, the same as the chat transports (nativeKeyState.NATIVE_EVENT_NAMES). Kept local so that this module stands alone. */
const WATCH_EVENT_NAMES = ['cashtreesios', 'cashtreesandroid'] as const

/** The payload of a `chatModuleEvent` detail (same read as nativeKeyState.eventPayloadOf). */
function payloadOf(ev: Event): unknown {
	const detail = (ev as CustomEvent).detail as Record<string, unknown> | undefined
	if (!detail || typeof detail !== 'object' || detail.action !== 'chatModuleEvent') return null
	return detail.event ?? detail.payload ?? null
}

export type PasscodeState = { set: boolean; locked: boolean }

/** Reads one passcodeState payload. Both fields must be booleans; anything else is not the state. */
export function parsePasscodeStateEvent(payload: unknown): PasscodeState | null {
	if (!payload || typeof payload !== 'object') return null
	const p = payload as { type?: unknown; set?: unknown; locked?: unknown }
	if (p.type !== 'passcodeState') return null
	if (typeof p.set !== 'boolean' || typeof p.locked !== 'boolean') return null
	return { set: p.set, locked: p.locked }
}

/** Calls `onState` for each valid passcodeState event. Returns the remover, or null when there is no window. */
export function installPasscodeStateWatcher(onState: (state: PasscodeState) => void): (() => void) | null {
	if (typeof window === 'undefined') return null
	const listener = (ev: Event) => {
		const state = parsePasscodeStateEvent(payloadOf(ev))
		if (state) onState(state)
	}
	for (const name of WATCH_EVENT_NAMES) window.addEventListener(name, listener)
	return () => {
		for (const name of WATCH_EVENT_NAMES) window.removeEventListener(name, listener)
	}
}
