/**
 * The numeric reqId spaces of the native ack channel (0.53.39, independent review of r5).
 *
 * The shared transaction sequence (shellTxSeq.ts) is a millisecond-scale number (about 1.7e12 in 2026), not a small counter.
 * pwaWalletSync uses PWA_WALLET_SYNC_REQ_BASE + seq, and the pre-read used to use the same seq stream with a +1,000,000 offset. Two
 * requests 1,000,000 ms apart could then share a reqId while both were pending. The pre-read therefore has its own range.
 *
 * Ranges (for any millisecond-scale seq from 1.7e12 to 2.9e12):
 *   PWA_WALLET_SYNC_REQ_BASE + seq   ~ 9.0e8 + 1.7e12 .. 2.9e12 + 9e8     (below PREREAD_REQ_BASE)
 *   PREREAD_REQ_BASE + seq           3.0e12 + 1.7e12 .. 3.0e12 + 2.9e12   (above the sync range)
 *   IMPORT_REQ_BASE + importSeq      8.8e8 + a small counter               (below the sync range)
 * The import base is a preventive choice: its counter is small and cannot meet the sequence range.
 */
export const PWA_WALLET_SYNC_REQ_BASE = 900_000_000
export const PREREAD_REQ_BASE = 3_000_000_000_000
export const IMPORT_REQ_BASE = 880_000_000
/**
 * Shell passcode commands: a small counter on this base. It sits above the pre-read range
 * (its millisecond-scale upper bound is 3e12 + 2.9e12 = 5.9e12) and well above every other base, so it never meets a sync, pre-read,
 * or small-counter request. Proposed; the protocol is not frozen until the independent review and the two SDK seats confirm.
 */
export const SHELL_PASSCODE_REQ_BASE = 7_000_000_000_000
/** Upper bound (exclusive) of the page's shell passcode counter. */
export const SHELL_PASSCODE_REQ_LIMIT = 7_500_000_000_000
/** The native-issued repair request range (r2): its own counter, after the page range. Upper bound exclusive. */
export const NATIVE_REPAIR_REQ_BASE = 7_500_000_000_000
export const NATIVE_REPAIR_REQ_LIMIT = 7_600_000_000_000

export const pwaWalletSyncReqIdFor = (seq: number): number => PWA_WALLET_SYNC_REQ_BASE + seq
export const prereadReqIdFor = (seq: number): number => PREREAD_REQ_BASE + seq
export const shellPasscodeReqIdFor = (counter: number): number => {
	if (!Number.isInteger(counter) || counter < 0 || SHELL_PASSCODE_REQ_BASE + counter >= SHELL_PASSCODE_REQ_LIMIT) throw new Error('shell_passcode_reqid_exhausted')
	return SHELL_PASSCODE_REQ_BASE + counter
}
