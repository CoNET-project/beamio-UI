/**
 * The shared identity prompt on screen: raised by a blocked check after a tap, with a retry and a close action.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import IdentityEntryPrompt from './IdentityEntryPrompt'
import { IDENTITY_ENTRY_PROMPT_EVENT } from '../services/identityEntryPrompt'
import { onNativeIdentityRetryRequested } from '../services/nativeIdentityProbeRetry'
import { tu } from '../locale/beamioLocale'

jest.mock('../services/shellChatCapability', () => ({ shellChatBlockedNow: jest.fn(() => false) }))

describe('the shared identity prompt on screen', () => {
	it('is hidden until a blocked check is raised, then shows the hint with retry and close', async () => {
		render(<IdentityEntryPrompt />)
		expect(screen.queryByRole('dialog')).toBeNull()
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
		})
		expect(await screen.findByRole('dialog')).toBeTruthy()
		expect(screen.getByText(tu('native_not_ready_hint'))).toBeTruthy()
		expect(screen.getByRole('button', { name: tu('close') })).toBeTruthy()
	})

	it('retry requests a probe and closes the prompt', async () => {
		const retry = jest.fn()
		const off = onNativeIdentityRetryRequested(retry)
		render(<IdentityEntryPrompt />)
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
		})
		fireEvent.click(await screen.findByRole('button', { name: tu('native_not_ready_retry_action') }))
		expect(retry).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole('dialog')).toBeNull()
		off()
	})
})
