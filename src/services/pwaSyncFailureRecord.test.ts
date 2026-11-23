/**
 * @jest-environment node
 *
 * v10 §六.1 (manual retry, record): only write_failed with rollback_pending is recorded; the record holds no key material; storage
 * unavailable reads as no record. Test IDs MR-1 to MR-5 are my own naming (the r11 IDs were not found in the plan files).
 */
import {
	accountMarker,
	clearFailureRecord,
	PWA_SYNC_FAILURE_KEY,
	readFailureRecord,
	recordForFailure,
	recordMatchesAccount,
	writeFailureRecord,
} from './pwaSyncFailureRecord'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const NOW = new Date('2026-11-18T10:00:00.000Z')

function memStore() {
	const m = new Map<string, string>()
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

describe('pwaSyncFailureRecord (v10 §六.1)', () => {
	it('MR-1: only write_failed with rollback_pending is recorded', () => {
		expect(recordForFailure({ code: 'write_failed', reason: 'rollback_pending' }, EOA, NOW)).not.toBeNull()
		expect(recordForFailure({ code: 'write_failed', reason: 'storage_write' }, EOA, NOW)).toBeNull()
		expect(recordForFailure({ code: 'no_answer' }, EOA, NOW)).toBeNull()
	})

	it('MR-2: the record holds only the reason, the account marker and the time (no key material, no full address)', () => {
		const rec = recordForFailure({ code: 'write_failed', reason: 'rollback_pending' }, EOA, NOW)!
		expect(Object.keys(rec).sort()).toEqual(['account', 'at', 'reason'])
		expect(rec.account).toBe(accountMarker(EOA))
		expect(rec.account).not.toContain(EOA)
		expect(rec.at).toBe('2026-11-18T10:00:00.000Z')
	})

	it('MR-3: one entry, overwritten; read back; cleared', () => {
		const store = memStore()
		const rec = recordForFailure({ code: 'write_failed', reason: 'rollback_pending' }, EOA, NOW)!
		writeFailureRecord(store, rec)
		writeFailureRecord(store, { ...rec, at: '2026-11-18T11:00:00.000Z' })
		expect(store.m.size).toBe(1)
		expect(store.m.has(PWA_SYNC_FAILURE_KEY)).toBe(true)
		expect(readFailureRecord(store)?.at).toBe('2026-11-18T11:00:00.000Z')
		clearFailureRecord(store)
		expect(readFailureRecord(store)).toBeNull()
	})

	it('MR-4: a missing or unavailable store reads as no record (fail-closed)', () => {
		expect(readFailureRecord(null)).toBeNull()
		const broken = { getItem: () => { throw new Error('denied') }, setItem: () => undefined, removeItem: () => undefined }
		expect(readFailureRecord(broken)).toBeNull()
	})

	it('MR-5: a record for another account does not match; this account matches', () => {
		const rec = recordForFailure({ code: 'write_failed', reason: 'rollback_pending' }, EOA, NOW)!
		expect(recordMatchesAccount(rec, EOA)).toBe(true)
		expect(recordMatchesAccount(rec, '0x1111111111111111111111111111111111111111')).toBe(false)
		expect(recordMatchesAccount(null, EOA)).toBe(false)
	})
})

import { manualRetryVisible } from './pwaSyncFailureRecord'

describe('manual retry visibility (v10 §六.2)', () => {
	const ok = { hasRecord: true, accountMatches: true, lastReplyEnvelopeLocked: false, hasValidPageMnemonic: true, nativeStatus: 'unlocked' }

	it('MR-9: shown only when all four conditions hold', () => {
		expect(manualRetryVisible(ok)).toBe(true)
	})

	it('MR-10: hidden when any one condition fails', () => {
		expect(manualRetryVisible({ ...ok, hasRecord: false })).toBe(false)
		expect(manualRetryVisible({ ...ok, accountMatches: false })).toBe(false)
		expect(manualRetryVisible({ ...ok, lastReplyEnvelopeLocked: true })).toBe(false)
		expect(manualRetryVisible({ ...ok, hasValidPageMnemonic: false })).toBe(false)
		expect(manualRetryVisible({ ...ok, nativeStatus: 'locked' })).toBe(false)
	})
})
