/**
 *a browser that cannot open its database, cannot read it, sees a damaged record, or times out is
 * undetermined. It gets the unavailable screen with retry and never onboarding. Pure decisions; SYNTHETIC inputs.
 */
import { BROWSER_UNAVAILABLE_REASONS, storageUnavailableRoute } from './storageRoute'
import { idbSignalOf, judgeBrowser } from './accountJudgement'

describe('browser storage failures are undetermined, never onboarding', () => {
	it('every browser reason routes to the unavailable screen', () => {
		for (const reason of [...BROWSER_UNAVAILABLE_REASONS, 'read_error', 'timeout', 'indexeddb', 'something_new']) {
			expect(storageUnavailableRoute({ nativeShell: false, reason })).toBe('unavailable')
		}
	})
	it('a browser native_retry is not a native route (it cannot come from a browser store)', () => {
		expect(storageUnavailableRoute({ nativeShell: false, reason: 'native_retry' })).toBe('unavailable')
	})
	it('the shell keeps its native retry; other shell reasons show the same unavailable screen', () => {
		expect(storageUnavailableRoute({ nativeShell: true, reason: 'native_retry' })).toBe('native_retry')
		expect(storageUnavailableRoute({ nativeShell: true, reason: 'indexeddb' })).toBe('unavailable')
	})
	it('IndexedDB did not open) judged at run time: undetermined, not absent', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'indexeddb' }))).toEqual({ account: 'undetermined', action: 'retry' })
	})
	it('read failed) judged at run time: undetermined', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'read_error' }))).toEqual({ account: 'undetermined', action: 'retry' })
	})
	it('a read that timed out is undetermined too (no status, so no absent)', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'timeout' }))).toEqual({ account: 'undetermined', action: 'retry' })
	})
	it('a damaged record is corrupt, which is still not absent', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'invalid_document' }))).not.toEqual({ account: 'no_account', action: 'onboard' })
	})
})

describe('2026-11-17 (iOS SDK 4ed82c6): an unreadable legacy store is an unavailable page with retry, never a wait', () => {
	it('native_unreadable routes to the unavailable page in a shell (no keep_waiting, no automatic retry), and never to onboarding', () => {
		expect(storageUnavailableRoute({ nativeShell: true, reason: 'native_unreadable' })).toBe('unavailable')
		expect(storageUnavailableRoute({ nativeShell: true, reason: 'native_retry' })).toBe('native_retry')
	})
})
