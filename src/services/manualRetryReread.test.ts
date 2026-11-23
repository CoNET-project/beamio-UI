/**
 * @jest-environment node
 *
 * PWA-RETRY-03 (v10.2 R-22). RR-1 to RR-5 are my own naming (the r11 IDs were not found in the plan files).
 */
import { needsReread, rereadDecision } from './manualRetryReread'

describe('PWA-RETRY-03: reread before a manual retry', () => {
	it('RR-1: a valid (address) reread sends', () => {
		expect(rereadDecision({ kind: 'address' })).toBe('send')
	})

	it('RR-2: an absent (no_key) reread sends', () => {
		expect(rereadDecision({ kind: 'refused', code: 'no_key' })).toBe('send')
	})

	it('RR-3: an unknown reread (locked, other refusal, timeout) does not send', () => {
		expect(rereadDecision({ kind: 'refused', code: 'locked' })).toBe('hold')
		expect(rereadDecision({ kind: 'refused', code: 'not_ready' })).toBe('hold')
		expect(rereadDecision({ kind: 'timeout' })).toBe('hold')
	})

	it('RR-4: internal_state and storage_write reread first', () => {
		expect(needsReread({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'internal_state' })).toBe(true)
		expect(needsReread({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'storage_write' })).toBe(true)
	})

	it('RR-7: no_answer reread: valid or absent sends, unknown does not (R-22)', () => {
		expect(needsReread({ kind: 'failed', code: 'no_answer', retryable: true })).toBe(true)
		expect(rereadDecision({ kind: 'address' })).toBe('send')
		expect(rereadDecision({ kind: 'refused', code: 'no_key' })).toBe('send')
		expect(rereadDecision({ kind: 'refused', code: 'locked' })).toBe('hold')
		expect(rereadDecision({ kind: 'timeout' })).toBe('hold')
	})

	it('RR-5: other states do not reread (rollback_pending has its own path; old_copy_unverified has no button)', () => {
		expect(needsReread({ kind: 'failed', code: 'write_failed', retryable: true, reason: 'rollback_pending' })).toBe(false)
		expect(needsReread({ kind: 'failed', code: 'write_failed', retryable: false, reason: 'old_copy_unverified' })).toBe(false)
		// R-22: no_answer is the unknown-reply class; a manual retry rereads first
		expect(needsReread({ kind: 'failed', code: 'no_answer', retryable: true })).toBe(true)
		expect(needsReread({ kind: 'idle' } as never)).toBe(false)
	})
})
