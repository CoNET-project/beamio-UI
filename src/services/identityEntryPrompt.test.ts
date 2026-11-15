/**
 * The shared identity prompt: raised only inside a user input event, once per dedupe window.
 */
import { currentUserInputEventType, IDENTITY_ENTRY_PROMPT_DEDUPE_MS, IDENTITY_ENTRY_PROMPT_EVENT, notifyIdentityEntryBlocked } from './identityEntryPrompt'

describe('the shared identity prompt: the user input rule', () => {
	it('is silent outside a user input event, and for an event that is not one', () => {
		const seen = jest.fn()
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		expect(notifyIdentityEntryBlocked(10_000_000, null)).toBe(false)
		expect(notifyIdentityEntryBlocked(10_000_000, 'message')).toBe(false)
		window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		expect(seen).not.toHaveBeenCalled()
	})

	it('is raised once for a press, and not again inside the dedupe window', () => {
		const seen = jest.fn()
		window.addEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
		const t = 20_000_000
		expect(notifyIdentityEntryBlocked(t, 'click')).toBe(true)
		expect(notifyIdentityEntryBlocked(t + 200, 'pointerdown')).toBe(false)
		expect(seen).toHaveBeenCalledTimes(1)
		window.removeEventListener(IDENTITY_ENTRY_PROMPT_EVENT, seen)
	})

	it('is raised again after the dedupe window', () => {
		const t = 30_000_000
		expect(notifyIdentityEntryBlocked(t, 'pointerdown')).toBe(true)
		expect(notifyIdentityEntryBlocked(t + IDENTITY_ENTRY_PROMPT_DEDUPE_MS + 1, 'keydown')).toBe(true)
	})

	it('reads the user input type from window.event inside a dispatched press, and null outside it', () => {
		let inside: string | null = 'unset'
		const button = document.createElement('button')
		button.addEventListener('click', () => {
			inside = currentUserInputEventType()
		})
		document.body.appendChild(button)
		button.click()
		button.remove()
		expect(inside).toBe('click')
		expect(currentUserInputEventType()).toBeNull()
	})
})
