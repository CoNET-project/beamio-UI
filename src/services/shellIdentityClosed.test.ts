/**
 * @jest-environment node
 *
 * the closed identity module. The source of the closed state, the mapping of the clearIdentity answer, and the
 * closed store the notice reads. SYNTHETIC values only.
 */
import {
	clearOutcomeOf,
	getIdentityClosed,
	identityClosedSource,
	importSwitchFailedThisSession,
	markImportSwitchFailed,
	setIdentityClosed,
	subscribeIdentityClosed,
	type IdentityClosedState,
} from './shellIdentityClosed'

describe('the source of a closed state', () => {
	it('unregister_refused is only answered by an account switch, so it is an import', () => {
		expect(identityClosedSource('unregister_refused', false)).toBe('import')
		expect(identityClosedSource('unregister_refused', true)).toBe('import')
	})

	it('clear_failed is a clear, unless this page session saw a failed import', () => {
		expect(identityClosedSource('clear_failed', false)).toBe('clear')
		expect(identityClosedSource('clear_failed', true)).toBe('import')
	})

	it('a failed import marks the session; the mark is kept for the session', () => {
		expect(importSwitchFailedThisSession()).toBe(false)
		markImportSwitchFailed()
		expect(importSwitchFailedThisSession()).toBe(true)
	})
})

describe('the clearIdentity answer', () => {
	it('an ack with ok true is a clear', () => {
		expect(clearOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: true, result: { ok: true } } })).toEqual({ kind: 'ok' })
	})

	it('unregister_refused is a refusal (nothing was removed)', () => {
		expect(clearOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'unregister_refused' } })).toEqual({ kind: 'refused' })
	})

	it('clear_failed keeps the notice: a failed outcome with its code', () => {
		expect(clearOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_failed' } })).toEqual({ kind: 'failed', code: 'clear_failed' })
	})

	it('a timeout, no channel, or an answer without an error code is a failed outcome, never a clear', () => {
		expect(clearOutcomeOf({ kind: 'timeout' })).toEqual({ kind: 'failed', code: 'timeout' })
		expect(clearOutcomeOf({ kind: 'unavailable' })).toEqual({ kind: 'failed', code: 'unavailable' })
		expect(clearOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: false } })).toEqual({ kind: 'failed', code: 'unknown' })
		expect(clearOutcomeOf({ kind: 'payload', payload: { type: 'ready', ok: true } })).toEqual({ kind: 'failed', code: 'unknown' })
	})
})

describe('the closed store the notice reads', () => {
	it('sets, reads and notifies; null clears it', () => {
		const seen: Array<IdentityClosedState> = []
		const off = subscribeIdentityClosed((s) => seen.push(s))
		setIdentityClosed({ reason: 'clear_failed', source: 'clear' })
		expect(getIdentityClosed()).toEqual({ reason: 'clear_failed', source: 'clear' })
		setIdentityClosed(null)
		expect(getIdentityClosed()).toBeNull()
		off()
		setIdentityClosed({ reason: 'unregister_refused', source: 'import' })
		expect(seen).toEqual([{ reason: 'clear_failed', source: 'clear' }, null])
		setIdentityClosed(null)
	})
})
