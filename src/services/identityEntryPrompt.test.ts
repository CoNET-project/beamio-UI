/**
 * The shared identity prompt: raised only after a recent tap or key press, once per dedupe window.
 */
import {
	IDENTITY_ENTRY_GESTURE_WINDOW_MS,
	IDENTITY_ENTRY_PROMPT_DEDUPE_MS,
	IDENTITY_ENTRY_PROMPT_EVENT,
	noteUserGesture,
	notifyIdentityEntryBlocked,
} from './identityEntryPrompt'

describe('the shared identity prompt', () => {
	it('is silent for a background check that no gesture precedes', () => {
		const seen = jest.fn()
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		expect(notifyIdentityEntryBlocked(10_000_000)).toBe(false)
		window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		expect(seen).not.toHaveBeenCalled()
	})

	it('is raised once for a blocked check right after a tap, and not again inside the dedupe window', () => {
		const seen = jest.fn()
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		const t = 20_000_000
		noteUserGesture(t)
		expect(notifyIdentityEntryBlocked(t + 100)).toBe(true)
		expect(notifyIdentityEntryBlocked(t + 200)).toBe(false)
		expect(seen).toHaveBeenCalledTimes(1)
		window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
	})

	it('a gesture older than the window does not raise it, and a later tap raises it again', () => {
		const seen = jest.fn()
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		const t = 30_000_000
		noteUserGesture(t)
		expect(notifyIdentityEntryBlocked(t + IDENTITY_ENTRY_GESTURE_WINDOW_MS + 1)).toBe(false)
		const later = t + IDENTITY_ENTRY_PROMPT_DEDUPE_MS + 1_000
		noteUserGesture(later)
		expect(notifyIdentityEntryBlocked(later + 10)).toBe(true)
		expect(seen).toHaveBeenCalledTimes(1)
		window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
	})
})
