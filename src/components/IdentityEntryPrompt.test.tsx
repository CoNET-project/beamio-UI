/**
 * The shared identity prompt on screen: raised by a blocked check after a tap, with a retry and a close action.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import IdentityEntryPrompt from './IdentityEntryPrompt'
import { IDENTITY_ENTRY_PROMPT_EVENT, IDENTITY_PROMPT_SILENT_WINDOW_MS, decideIdentityPrompt } from '../services/identityEntryPrompt'
import { onNativeIdentityRetryRequested, setNativeIdentityCapability } from '../services/nativeIdentityProbeRetry'
import { tu } from '../locale/beamioLocale'

jest.mock('../services/shellChatCapability', () => ({ shellChatBlockedNow: jest.fn(() => false) }))

describe('the shared identity prompt on screen', () => {
	it('is hidden until a blocked check is raised, then shows the hint with retry and close', async () => {
		jest.useFakeTimers()
		render(<IdentityEntryPrompt />)
		expect(screen.queryByRole('dialog')).toBeNull()
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
			jest.advanceTimersByTime(IDENTITY_PROMPT_SILENT_WINDOW_MS + 10)
		})
		jest.useRealTimers()
		expect(await screen.findByRole('dialog')).toBeTruthy()
		// no valid hello yet and the window is open: the wallet is getting ready (the hint text comes after the window)
		expect(screen.getByText(tu('native_preparing_wallet'))).toBeTruthy()
		expect(screen.getByRole('button', { name: tu('close') })).toBeTruthy()
	})

	it('retry requests a probe and closes the prompt', async () => {
		const retry = jest.fn()
		const off = onNativeIdentityRetryRequested(retry)
		jest.useFakeTimers()
		render(<IdentityEntryPrompt />)
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
			jest.advanceTimersByTime(IDENTITY_PROMPT_SILENT_WINDOW_MS + 10)
		})
		jest.useRealTimers()
		retry.mockClear()
		fireEvent.click(await screen.findByRole('button', { name: tu('native_not_ready_retry_action') }))
		expect(retry).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole('dialog')).toBeNull()
		off()
	})

	it('an answered hello without the capability shows the unavailable copy and no retry', async () => {
		setNativeIdentityCapability('missing')
		render(<IdentityEntryPrompt />)
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
		})
		expect(await screen.findByRole('dialog')).toBeTruthy()
		expect(screen.getByText(tu('shell_chat_unavailable_title'))).toBeTruthy()
		expect(screen.getByText(tu('shell_chat_unavailable_body'))).toBeTruthy()
		expect(screen.queryByRole('button', { name: tu('native_not_ready_retry_action') })).toBeNull()
		expect(screen.queryByText(tu('native_not_ready_hint'))).toBeNull()
		expect(screen.getByRole('button', { name: tu('close') })).toBeTruthy()
		setNativeIdentityCapability('unanswered')
	})

	it('a blocked check while the wallet is being prepared stays silent for 30 s (the native side is asked again), and the prompt shows only if the chat is still not live', async () => {
		const retry = jest.fn()
		const off = onNativeIdentityRetryRequested(retry)
		jest.useFakeTimers()
		render(<IdentityEntryPrompt />)
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
			jest.advanceTimersByTime(15_000)
		})
		expect(screen.queryByRole('dialog')).toBeNull()
		expect(retry).toHaveBeenCalled() // the silent re-ask
		act(() => { jest.advanceTimersByTime(14_000) })
		expect(screen.queryByRole('dialog')).toBeNull() // 29 s: still silent
		act(() => { jest.advanceTimersByTime(2_000) })
		jest.useRealTimers()
		expect(await screen.findByRole('dialog')).toBeTruthy() // 31 s and still not live
		off()
	})

	it('decideIdentityPrompt: unavailable shows at once; otherwise wait out the 30 s window of the streak', () => {
		expect(decideIdentityPrompt({ now: 5, firstBlockedAt: null, unavailable: true })).toEqual({ action: 'show' })
		expect(decideIdentityPrompt({ now: 1000, firstBlockedAt: null, unavailable: false })).toEqual({ action: 'wait', recheckInMs: 30_000 })
		expect(decideIdentityPrompt({ now: 11_000, firstBlockedAt: 1000, unavailable: false })).toEqual({ action: 'wait', recheckInMs: 20_000 })
		expect(decideIdentityPrompt({ now: 31_000, firstBlockedAt: 1000, unavailable: false })).toEqual({ action: 'show' })
	})

	it('after the prompt was shown (30 s) and closed, the next blocked press shows it at once, not after another silent window', async () => {
		jest.useFakeTimers()
		render(<IdentityEntryPrompt />)
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
			jest.advanceTimersByTime(IDENTITY_PROMPT_SILENT_WINDOW_MS + 10)
		})
		expect(screen.queryByRole('dialog')).not.toBeNull()
		fireEvent.click(screen.getByRole('button', { name: tu('close') }))
		expect(screen.queryByRole('dialog')).toBeNull()
		act(() => {
			window.dispatchEvent(new Event(IDENTITY_ENTRY_PROMPT_EVENT))
			jest.advanceTimersByTime(5) // only the turn the prompt state is set on
		})
		expect(screen.queryByRole('dialog')).not.toBeNull()
		jest.useRealTimers()
	})
})

