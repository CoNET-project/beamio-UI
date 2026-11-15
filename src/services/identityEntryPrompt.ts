/**
 * The shared prompt for an identity entry that is blocked in a shell without identity.native-keys.v1.
 *
 * A blocked check raises the prompt only when it runs synchronously inside a user input event (a press, a click or a key).
 * A background call, or a call after an await, sees no user event and stays silent. The prompt is raised at most once per
 * dedupe window, so one press gives one prompt even when several guards fire for it.
 */

export const IDENTITY_ENTRY_PROMPT_EVENT = 'beamio:identityEntryPrompt'
/** Blocked checks within this window raise the prompt once. */
export const IDENTITY_ENTRY_PROMPT_DEDUPE_MS = 2_000

/** The user input events that count as a press. */
export const USER_INPUT_EVENT_TYPES: readonly string[] = ['pointerdown', 'pointerup', 'click', 'keydown']

let lastPromptAt = Number.NEGATIVE_INFINITY

/** The type of the user input event being dispatched right now, or null outside one (window.event). */
export function currentUserInputEventType(): string | null {
	if (typeof window === 'undefined') return null
	const ev = (window as unknown as { event?: Event | undefined }).event
	return ev && USER_INPUT_EVENT_TYPES.includes(ev.type) ? ev.type : null
}

/**
 * Raises the shared prompt for a blocked identity entry. Returns whether it was raised. Silent outside a user input event
 * and silent inside the dedupe window.
 */
export function notifyIdentityEntryBlocked(now: number = Date.now(), eventType: string | null = currentUserInputEventType()): boolean {
	if (!eventType || !USER_INPUT_EVENT_TYPES.includes(eventType)) return false
	if (now - lastPromptAt < IDENTITY_ENTRY_PROMPT_DEDUPE_MS) return false
	lastPromptAt = now
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
	return true
}
