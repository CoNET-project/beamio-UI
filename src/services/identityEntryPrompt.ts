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

/**
 * A blocked check while the native identity is
 * still being prepared is treated as "waiting for the native identity": the page asks the native side again silently and shows the prompt only if the chat is still not live after this window.
 * A shell that has answered without the capability (`unavailable`) needs no waiting: a retry cannot succeed.
 */
export const IDENTITY_PROMPT_SILENT_WINDOW_MS = 30_000

export type IdentityPromptDecision = { action: 'show' } | { action: 'wait'; recheckInMs: number }

/** `firstBlockedAt` is the time of the first blocked check of this streak (null: this is the first); the streak ends when the chat is live. */
export function decideIdentityPrompt(input: { now: number; firstBlockedAt: number | null; unavailable: boolean }): IdentityPromptDecision {
	if (input.unavailable) return { action: 'show' }
	const since = input.firstBlockedAt === null ? 0 : Math.max(0, input.now - input.firstBlockedAt)
	if (since >= IDENTITY_PROMPT_SILENT_WINDOW_MS) return { action: 'show' }
	return { action: 'wait', recheckInMs: IDENTITY_PROMPT_SILENT_WINDOW_MS - since }
}

/**
 * a silent retry is not a fix. While a blocked press is being waited out (the silent window), the user must SEE that the wallet is being prepared, and see the change when
 * it is ready: a "preparing" status from the first blocked press, "ready" for a moment when the chat turns live, and the existing dialog (with Retry) if the window runs out. Pure decision; the component renders it.
 *  - none: nothing to show. preparing: waiting for the native identity, the chat is not live. ready: it was waiting and the chat is live now.
 */
export const IDENTITY_READY_FLASH_MS = 2_500
export type ReadinessFeedback = 'none' | 'preparing' | 'ready'
export function readinessFeedbackOf(input: { waiting: boolean; live: boolean; dialogOpen: boolean; readyFlash: boolean }): ReadinessFeedback {
	if (input.live) return input.readyFlash ? 'ready' : 'none'
	if (input.dialogOpen) return 'none' // the dialog says it (with Retry)
	return input.waiting ? 'preparing' : 'none'
}

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
