/**
 * The shared prompt for an identity entry that is blocked in a shell without identity.native-keys.v1.
 *
 * A blocked check raises the prompt only when the user has just pressed or typed: a background call that is not
 * preceded by a gesture stays silent. The prompt is raised at most once per dedupe window, so one tap gives one prompt
 * even when several guards fire for it.
 */

export const IDENTITY_ENTRY_PROMPT_EVENT = 'beamio:identityEntryPrompt'
/** A blocked check counts as the result of a tap or key press when the gesture is at most this old. */
export const IDENTITY_ENTRY_GESTURE_WINDOW_MS = 1_000
/** Blocked checks within this window raise the prompt once. */
export const IDENTITY_ENTRY_PROMPT_DEDUPE_MS = 2_000

let lastGestureAt = Number.NEGATIVE_INFINITY
let lastPromptAt = Number.NEGATIVE_INFINITY

export function noteUserGesture(now: number = Date.now()): void {
	lastGestureAt = now
}

/**
 * Raises the shared prompt for a blocked identity entry. Returns whether it was raised. Silent without a recent gesture,
 * and silent inside the dedupe window.
 */
export function notifyIdentityEntryBlocked(now: number = Date.now()): boolean {
	if (now - lastGestureAt > IDENTITY_ENTRY_GESTURE_WINDOW_MS) return false
	if (now - lastPromptAt < IDENTITY_ENTRY_PROMPT_DEDUPE_MS) return false
	lastPromptAt = now
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
	return true
}

/** Records the user's taps and key presses. Returns the removal function. */
export function installIdentityEntryGesture(target: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
	if (!target) return () => {}
	const onGesture = () => noteUserGesture()
	target.addEventListener('pointerdown', onGesture, true)
	target.addEventListener('keydown', onGesture, true)
	return () => {
		target.removeEventListener('pointerdown', onGesture, true)
		target.removeEventListener('keydown', onGesture, true)
	}
}
