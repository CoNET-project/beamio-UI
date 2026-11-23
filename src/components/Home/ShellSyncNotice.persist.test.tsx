/**
 * 0.53.39 (item 3): a save that did not complete shows the notice in the sync notice's position, with a retry button
 * that runs the save again. The text is the localized key (the test renders the key).
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import ShellSyncNotice from './ShellSyncNotice'
import { resetPersistNotice, retryPersist, setPersistFailed, setPersistRetry, clearPersistFailed } from '@/services/persistNoticeStatus'
import { resetShellSyncStatus } from '@/services/shellSyncStatus'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key }))

describe('ShellSyncNotice: a save that did not complete', () => {
	beforeEach(() => {
		resetShellSyncStatus()
		resetPersistNotice()
	})

	it('shows the save notice and the retry button when the save did not complete, and nothing when it did', () => {
		render(<ShellSyncNotice />)
		expect(screen.queryByText('persist_save_not_completed')).toBeNull()
		act(() => setPersistFailed())
		expect(screen.getByText('persist_save_not_completed')).toBeTruthy()
		expect(screen.getByText('persist_retry_action')).toBeTruthy()
		act(() => clearPersistFailed())
		expect(screen.queryByText('persist_save_not_completed')).toBeNull()
	})

	it('the retry button runs the registered save again', () => {
		const retry = jest.fn()
		setPersistRetry(retry)
		render(<ShellSyncNotice />)
		act(() => setPersistFailed())
		fireEvent.click(screen.getByText('persist_retry_action'))
		expect(retry).toHaveBeenCalledTimes(1)
	})

	it('with no retry registered, the retry reports false and the notice stays (never silent)', () => {
		setPersistRetry(null)
		expect(retryPersist()).toBe(false)
		render(<ShellSyncNotice />)
		act(() => setPersistFailed())
		expect(screen.getByText('persist_save_not_completed')).toBeTruthy()
	})
})
