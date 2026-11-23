/**
 * @jest-environment node
 */
import { IMPORT_REQ_BASE, NATIVE_REPAIR_REQ_BASE, NATIVE_REPAIR_REQ_LIMIT, PREREAD_REQ_BASE, PWA_WALLET_SYNC_REQ_BASE, SHELL_PASSCODE_REQ_BASE, SHELL_PASSCODE_REQ_LIMIT, prereadReqIdFor, pwaWalletSyncReqIdFor, shellPasscodeReqIdFor } from './reqIdSpaces'

// The shared transaction sequence is millisecond-scale (shellTxSeq.ts): about 1.7e12 in 2026. The ranges are checked over that scale.
const SEQ_MIN = 1_700_000_000_000
const SEQ_MAX = 2_900_000_000_000

describe('reqId spaces on the native ack channel (preventive correction; millisecond-scale seq)', () => {
	it('a pre-read and a sync whose seq differ by exactly 1,000,000 never share a reqId (the case the review found)', () => {
		const s1 = 1_780_000_000_000
		const s2 = s1 + 1_000_000
		expect(prereadReqIdFor(s1)).not.toBe(pwaWalletSyncReqIdFor(s2))
		expect(pwaWalletSyncReqIdFor(s1)).not.toBe(prereadReqIdFor(s1))
	})

	it('for every millisecond-scale seq in range, the pre-read range is disjoint from the sync range', () => {
		const syncLo = pwaWalletSyncReqIdFor(SEQ_MIN)
		const syncHi = pwaWalletSyncReqIdFor(SEQ_MAX)
		const prereadLo = prereadReqIdFor(SEQ_MIN)
		const prereadHi = prereadReqIdFor(SEQ_MAX)
		expect(syncHi < prereadLo || prereadHi < syncLo).toBe(true)
		expect(syncHi).toBeLessThan(PREREAD_REQ_BASE)
	})

	it('the import range (small counter) is disjoint from the sync and pre-read ranges', () => {
		const importHi = IMPORT_REQ_BASE + 10_000_000
		expect(importHi).toBeLessThan(PWA_WALLET_SYNC_REQ_BASE)
		expect(importHi).toBeLessThan(pwaWalletSyncReqIdFor(SEQ_MIN))
	})

	it('the sync and pre-read reqIds are safe integers over the whole range', () => {
		expect(Number.isSafeInteger(prereadReqIdFor(SEQ_MAX))).toBe(true)
		expect(Number.isSafeInteger(pwaWalletSyncReqIdFor(SEQ_MAX))).toBe(true)
	})

	it('the shell passcode range is disjoint from the pre-read, sync and import ranges (over the millisecond-scale seq, and a counter up to 1e9)', () => {
		const passLo = shellPasscodeReqIdFor(0)
		const passHi = shellPasscodeReqIdFor(1_000_000_000)
		expect(passLo).toBeGreaterThan(prereadReqIdFor(SEQ_MAX))
		expect(passLo).toBeGreaterThan(pwaWalletSyncReqIdFor(SEQ_MAX))
		expect(passHi).toBeLessThan(Number.MAX_SAFE_INTEGER)
		expect(SHELL_PASSCODE_REQ_BASE).toBeGreaterThan(IMPORT_REQ_BASE + 10_000_000)
	})

	it('r2: the page passcode range and the native repair range are disjoint, each has an upper bound, and the page range refuses to exceed its bound', () => {
		expect(SHELL_PASSCODE_REQ_LIMIT).toBeLessThanOrEqual(NATIVE_REPAIR_REQ_BASE)
		expect(NATIVE_REPAIR_REQ_LIMIT).toBeGreaterThan(NATIVE_REPAIR_REQ_BASE)
		expect(NATIVE_REPAIR_REQ_BASE).toBeGreaterThan(prereadReqIdFor(SEQ_MAX))
		expect(shellPasscodeReqIdFor(SHELL_PASSCODE_REQ_LIMIT - SHELL_PASSCODE_REQ_BASE - 1)).toBe(SHELL_PASSCODE_REQ_LIMIT - 1)
		expect(() => shellPasscodeReqIdFor(SHELL_PASSCODE_REQ_LIMIT - SHELL_PASSCODE_REQ_BASE)).toThrow('shell_passcode_reqid_exhausted')
		expect(() => shellPasscodeReqIdFor(-1)).toThrow()
	})
})
