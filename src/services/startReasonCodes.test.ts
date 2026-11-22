/**
 * @jest-environment node
 */
import { isStartReasonCode, START_REASON_CODES, startReasonLine } from './startReasonCodes'
import { bridgeTrustState, nativeStartRoute, prereadPageRoute } from './accountJudgement'
import { prereadFromAnswer } from './nativeRecovery'

describe('start reason codes (one table, redacted)', () => {
	it('every reason the start route can return is in the table', () => {
		const base = { walletState: 'absent' as const, hasKey: false as const, walletStatus: 'no_key' }
		const cases = [
			nativeStartRoute({ ...base, pre: { kind: 'valid' } }),
			nativeStartRoute({ ...base, pre: { kind: 'locked' } }),
			nativeStartRoute({ ...base, pre: { kind: 'unknown', reason: 'unsupported' } }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' }, hasKey: true }),
			nativeStartRoute({ ...base, pre: { kind: 'unknown' } }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'present' as const }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'unknown' as const }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletState: 'not_ready' as const }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' }, walletStatus: 'not_ready' }),
			nativeStartRoute({ ...base, pre: { kind: 'absent' } }),
		]
		for (const c of cases) expect(isStartReasonCode(c.reason)).toBe(true)
		expect(isStartReasonCode(bridgeTrustState({ identity: 'unanswered', elapsedMs: 20_000 }).reason ?? '')).toBe(true)
		expect(isStartReasonCode(prereadPageRoute('unavailable') === 'wait_retry' ? 'page_read_failed' : '')).toBe(true)
	})

	it('a code outside the table is not a code', () => {
		expect(isStartReasonCode('password_fragment')).toBe(false)
		expect(isStartReasonCode('mnemonic')).toBe(false)
	})

	it('the log line carries the correlation id when there is one, and no material', () => {
		expect(startReasonLine('pre_unknown', 900000001)).toBe('[start] reason=pre_unknown reqId=900000001')
		expect(startReasonLine('confirmed_absent')).toBe('[start] reason=confirmed_absent')
		for (const code of Object.keys(START_REASON_CODES)) {
			expect(startReasonLine(code as keyof typeof START_REASON_CODES, 1)).not.toMatch(/phrase|key=|0x[0-9a-fA-F]{40}/)
		}
	})

	it('a native pre-read answer that is not valid maps to a table reason, never to a mnemonic', () => {
		expect(prereadFromAnswer({ kind: 'timeout' }).kind).toBe('unknown')
	})
})

import { IMPORT_REQ_BASE } from './nativeKeyState'

describe('reqId spaces (preventive correction; the range checks are in reqIdSpaces.test.ts)', () => {
	it('preventive correction: the import range is disjoint from the sync and pre-read ranges (small counter vs millisecond seq)', () => {
		const importRange = [IMPORT_REQ_BASE + 1, IMPORT_REQ_BASE + 1_000_000]
		const syncRange = [900_000_000 + 1, 900_000_000 + 1_000_000]
		const prereadRange = [901_000_000 + 1, 901_000_000 + 1_000_000]
		const overlaps = (a: number[], b: number[]) => a[0] <= b[1] && b[0] <= a[1]
		expect(overlaps(importRange, syncRange)).toBe(false)
		expect(overlaps(importRange, prereadRange)).toBe(false)
	})
	it('the import base is not inside the chat, cleanup, destroy, shell or query bases', () => {
		for (const base of [700_000_000, 770_000_000, 790_000_000, 810_000_000, 950_000_000]) {
			expect(Math.abs(IMPORT_REQ_BASE - base)).toBeGreaterThan(1_000_000)
		}
	})
})
