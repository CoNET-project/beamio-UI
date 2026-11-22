/**
 *the home's sync state holds a state and a retry only. SYNTHETIC values only.
 */
import { getShellSyncState, resetShellSyncStatus, retryShellSync, setShellSyncRetry, setShellSyncState } from './shellSyncStatus'

beforeEach(() => resetShellSyncStatus())

describe('shell sync status (home view)', () => {
	it('retry is false when nothing is registered, and runs the registered action when it is', () => {
		expect(retryShellSync()).toBe(false)
		const action = jest.fn()
		setShellSyncRetry(action)
		expect(retryShellSync()).toBe(true)
		expect(action).toHaveBeenCalledTimes(1)
	})

	it('a throwing retry is contained: the caller gets false and no exception', () => {
		setShellSyncRetry(() => {
			throw new Error('boom')
		})
		expect(() => retryShellSync()).not.toThrow()
		expect(retryShellSync()).toBe(false)
	})

	it('a failed state carries only the code and the retryable flag (no value of the wallet)', () => {
		setShellSyncState({ kind: 'failed', code: 'write_failed', retryable: true })
		expect(Object.keys(getShellSyncState()).sort()).toEqual(['code', 'kind', 'retryable'])
	})

	it('reset returns to idle and clears the retry', () => {
		setShellSyncState({ kind: 'synced' })
		setShellSyncRetry(() => undefined)
		resetShellSyncStatus()
		expect(getShellSyncState()).toEqual({ kind: 'idle' })
		expect(retryShellSync()).toBe(false)
	})
})
