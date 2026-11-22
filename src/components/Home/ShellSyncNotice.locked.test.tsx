/**
 * HC-LOCK L-SYNC (UI): a locked sync is a non-blocking explanation with no retry button (the unlock re-runs the sync).
 */
import { act, render, screen } from '@testing-library/react'
import ShellSyncNotice from './ShellSyncNotice'
import { resetShellSyncStatus, setShellSyncState } from '@/services/shellSyncStatus'

jest.mock('@/locale/beamioLocale', () => ({ ...jest.requireActual('@/locale/beamioLocale'), tu: (key: string) => key }))

describe('ShellSyncNotice locked (HC-LOCK L-SYNC)', () => {
	beforeEach(() => resetShellSyncStatus())

	it('locked shows the locked explanation and no retry button', () => {
		render(<ShellSyncNotice />)
		act(() => setShellSyncState({ kind: 'failed', code: 'locked', retryable: false }))
		expect(screen.getByText('shell_sync_native_locked_title')).toBeTruthy()
		expect(screen.getByText('shell_sync_native_locked_body')).toBeTruthy()
		expect(screen.queryByText('shell_sync_retry_action')).toBeNull()
		expect(screen.queryByText('shell_sync_refused_body')).toBeNull()
	})

	it('regression: a retryable no_answer still shows the retry button', () => {
		render(<ShellSyncNotice />)
		act(() => setShellSyncState({ kind: 'failed', code: 'no_answer', retryable: true }))
		expect(screen.getByText('shell_sync_retry_action')).toBeTruthy()
		expect(screen.queryByText('shell_sync_native_locked_title')).toBeNull()
	})
})
