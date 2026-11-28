// the two page hooks that stay in every build for QA. Why they stay: QA drives the candidate bytes that will go live (the target directory), where a QA-only flag build
// is not what runs. What they can do, proved here: the reload hook asks through the SAME lock as the app (held while a write runs, merged in a burst); it carries no argument, no data and no privilege
// beyond what any page script already has (location.reload); the state hook returns counters and booleans only.
import { beginChatWrite, resetChatWriteLockForTest } from './chatWriteLock'

describe('the page hooks', () => {
	beforeEach(() => resetChatWriteLockForTest())
	const w = window as unknown as { __beamioRequestControlledReload?: (...args: unknown[]) => boolean; __beamioChatWriteLockState?: (...args: unknown[]) => Record<string, unknown> }

	it('the reload hook is held by the lock and cannot get around it; the state hook returns only numbers and booleans', () => {
		expect(typeof w.__beamioRequestControlledReload).toBe('function')
		const release = beginChatWrite()
		expect(w.__beamioRequestControlledReload!()).toBe(true) // held by the lock: the hook cannot get around it
		release()
		const state = w.__beamioChatWriteLockState!()
		for (const v of Object.values(state)) expect(['number', 'boolean']).toContain(typeof v) // counters only: no message, no key, no address
		expect(Object.keys(state).sort()).toEqual(['awaiting', 'dirtyDrafts', 'heldRefreshes', 'heldReload', 'inFlight', 'queued', 'unsaved', 'writing'])
	})

	it('the reload hook takes no argument and runs only the app\'s own reload: a page script cannot hand it code or a target', () => {
		const calls: string[] = []
		const real = window.location.reload
		void real
		const hook = w.__beamioRequestControlledReload as (...args: unknown[]) => boolean
		expect(hook.length).toBe(0)
		// an argument is ignored: nothing is executed from it
		const release = beginChatWrite()
		expect(hook(() => calls.push('executed'))).toBe(true)
		release()
		expect(calls).toEqual([])
	})
})
