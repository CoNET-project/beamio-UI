/**
 * The trigger rule of the old-account cleanup (2026-11-21: the cleanup runs silently after a completed recovery, with no extra
 * pick and no notice; the rule keeps the recovery-success and read-back criteria). It runs only when:
 * - the native recovery succeeded (ok), and
 * - the page's IDB-derived account address and the native address agree (both valid lower-case 0x + 40 hex; unreadable or different does not agree),
 * - and no cleanup for this account is already running or done (a repeated callback never deletes twice).
 * It never runs on a failed, incomplete or refused recovery, on a read-back failure, or on an address mismatch. Only the native layer decides what is
 * deleted: the old account's own data; the recovered account, its wallet, chat and any unattributable data are kept. Pure.
 */

/** The page's read-back input: the account address the page derives from its IDB record (lower-case hex). Null when unreadable. */
export type ReadBackAddress = string | null

const ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** The two read-backs (the page's IDB-derived address and the native address) agree: both valid, equal, case-insensitive. Pure. */
export function readBackAgrees(pageAddress: ReadBackAddress, nativeAddress: string | null): boolean {
	if (!pageAddress || !nativeAddress) return false
	const p = pageAddress.trim().toLowerCase()
	const n = nativeAddress.trim().toLowerCase()
	return ADDRESS_RE.test(p) && ADDRESS_RE.test(n) && p === n
}

/**
 * May the silent cleanup start now? Recovery ok AND the read-backs agree AND it is not already in flight or done for this account. Pure.
 */
export function cleanupMayRun(input: { nativeRecoveryOk: boolean; readBack: boolean; inFlightOrDone: boolean }): boolean {
	return input.nativeRecoveryOk && input.readBack && !input.inFlightOrDone
}

const ACCOUNT_KEY_RE = /^0x[0-9a-f]{40}$/

/**
 * The accountKey of the cleanup command: the account address the page reads from IDB and derives, lower-case 0x + 40 hex.
 * Returns it, or null when it cannot be read or is malformed. A null means no cleanup command is sent. Pure.
 */
export function confirmationAccountKey(readAddress: unknown): string | null {
	if (typeof readAddress !== 'string') return null
	const a = readAddress.trim().toLowerCase()
	return ACCOUNT_KEY_RE.test(a) ? a : null
}

/**
 * The whole decision for the silent cleanup after a recovery callback (pure): the account key to clean for, or null (do nothing). It uses the
 * same criteria as cleanupMayRun, with the page's derived address as the accountKey, and never starts for a native address that differs.
 */
export function silentCleanupDecision(input: {
	nativeRecoveryOk: boolean
	pageAddress: unknown
	nativeAddress: string | null
	inFlightOrDone: boolean
}): string | null {
	const key = confirmationAccountKey(input.pageAddress)
	const agrees = readBackAgrees(key, input.nativeAddress)
	return cleanupMayRun({ nativeRecoveryOk: input.nativeRecoveryOk, readBack: agrees, inFlightOrDone: input.inFlightOrDone }) ? key : null
}
