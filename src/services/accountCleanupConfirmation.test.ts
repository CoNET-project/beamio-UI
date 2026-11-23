/**
 * The silent cleanup trigger (owner decision 2026-11-21). Table-driven: recovery (ok, not ok) × read-back (agrees, not, unreadable) × in-flight/done.
 * Only "recovery ok, read-back agrees, not in flight or done" runs. Failure, incomplete, read-back failure, mismatch and repeat never run.
 */
import { cleanupMayRun, readBackAgrees, silentCleanupDecision } from './accountCleanupConfirmation'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)

describe('cleanupMayRun: recovery × read-back × in-flight/done (2 × 2 × 2 = 8 rows; exactly one runs)', () => {
	const rows: Array<{ recovery: boolean; readBack: boolean; busy: boolean; expected: boolean }> = []
	for (const recovery of [true, false]) for (const readBack of [true, false]) for (const busy of [false, true]) {
		rows.push({ recovery, readBack, busy, expected: recovery && readBack && !busy })
	}
	it.each(rows)('recovery=$recovery readBack=$readBack inFlightOrDone=$busy → $expected', ({ recovery, readBack, busy, expected }) => {
		expect(cleanupMayRun({ nativeRecoveryOk: recovery, readBack, inFlightOrDone: busy })).toBe(expected)
	})
	it('exactly one of the eight rows runs the cleanup', () => {
		expect(rows).toHaveLength(8)
		expect(rows.filter((r) => cleanupMayRun({ nativeRecoveryOk: r.recovery, readBack: r.readBack, inFlightOrDone: r.busy })).length).toBe(1)
	})
})

describe('readBackAgrees (page IDB-derived address × native address)', () => {
	const rows: Array<{ page: string | null | undefined; native: string | null | undefined; expected: boolean; why: string }> = [
		{ page: A, native: A, expected: true, why: 'equal addresses' },
		{ page: A, native: A.toUpperCase().replace('0X', '0x'), expected: true, why: 'equal, case-insensitive' },
		{ page: '  ' + A + '  ', native: A, expected: true, why: 'surrounding spaces are trimmed' },
		{ page: A, native: B, expected: false, why: 'different addresses (mismatch)' },
		{ page: null, native: A, expected: false, why: 'page side unreadable (null)' },
		{ page: A, native: null, expected: false, why: 'native side unreadable (null)' },
		{ page: undefined, native: A, expected: false, why: 'page side missing (undefined)' },
		{ page: '', native: A, expected: false, why: 'page side empty' },
		{ page: A, native: '', expected: false, why: 'native side empty' },
		{ page: 'not-an-address', native: 'not-an-address', expected: false, why: 'not an address (equal strings)' },
		{ page: '0x' + 'a'.repeat(39), native: '0x' + 'a'.repeat(39), expected: false, why: '39 hex digits' },
		{ page: '0x' + 'g'.repeat(40), native: '0x' + 'g'.repeat(40), expected: false, why: 'non-hex digits' },
	]
	for (const r of rows) {
		it(`${r.why} → ${r.expected}`, () => {
			expect(readBackAgrees(r.page as string | null, r.native as string | null)).toBe(r.expected)
		})
	}
})

describe('silentCleanupDecision: the callback decides, and only a clean match returns the derived key', () => {
	it('recovery ok, read-back agrees → the derived key (the cleanup starts, silently)', () => {
		expect(silentCleanupDecision({ nativeRecoveryOk: true, pageAddress: A, nativeAddress: A, inFlightOrDone: false })).toBe(A)
	})
	it('recovery not ok (failed or incomplete) → null, whatever the addresses', () => {
		expect(silentCleanupDecision({ nativeRecoveryOk: false, pageAddress: A, nativeAddress: A, inFlightOrDone: false })).toBeNull()
	})
	it('read-back mismatch → null (data kept)', () => {
		expect(silentCleanupDecision({ nativeRecoveryOk: true, pageAddress: A, nativeAddress: B, inFlightOrDone: false })).toBeNull()
	})
	it('page address unreadable → null (no command)', () => {
		expect(silentCleanupDecision({ nativeRecoveryOk: true, pageAddress: null, nativeAddress: A, inFlightOrDone: false })).toBeNull()
	})
	it('a repeated callback while in flight or already done → null (never a second deletion)', () => {
		expect(silentCleanupDecision({ nativeRecoveryOk: true, pageAddress: A, nativeAddress: A, inFlightOrDone: true })).toBeNull()
	})
})
