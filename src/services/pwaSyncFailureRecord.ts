/**
 * v10 §六.1 (manual retry): the persisted record of a held write. Written only for write_failed with reason rollback_pending. It holds
 * the reason, the account's first 6 and last 4 characters, and the time (ISO). It never holds key material, a phrase or a full address.
 * Stored as one entry (overwritten). A storage that is unavailable reads as no record (fail-closed).
 */
export const PWA_SYNC_FAILURE_KEY = 'beamio.pwaSyncFailure.v1'

export type PwaSyncFailureRecord = { reason: 'rollback_pending'; account: string; at: string }

/** The record's account marker: the first 6 and last 4 characters of the EOA (lower-case). */
export function accountMarker(eoa: string): string {
	const e = eoa.trim().toLowerCase()
	return `${e.slice(0, 6)}…${e.slice(-4)}`
}

/** The record to write for a failed sync, or null: only write_failed with rollback_pending is recorded (§六.1). */
export function recordForFailure(input: { code: string; reason?: string }, eoa: string, now: Date): PwaSyncFailureRecord | null {
	if (input.code !== 'write_failed' || input.reason !== 'rollback_pending') return null
	return { reason: 'rollback_pending', account: accountMarker(eoa), at: now.toISOString() }
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readFailureRecord(store: KV | null): PwaSyncFailureRecord | null {
	if (!store) return null
	try {
		const raw = store.getItem(PWA_SYNC_FAILURE_KEY)
		if (!raw) return null
		const r = JSON.parse(raw) as Partial<PwaSyncFailureRecord>
		if (r.reason !== 'rollback_pending' || typeof r.account !== 'string' || typeof r.at !== 'string') return null
		return { reason: 'rollback_pending', account: r.account, at: r.at }
	} catch {
		return null
	}
}

export function writeFailureRecord(store: KV | null, record: PwaSyncFailureRecord): void {
	try {
		store?.setItem(PWA_SYNC_FAILURE_KEY, JSON.stringify(record))
	} catch {
		/* fail-closed: nothing is claimed as recorded */
	}
}

export function clearFailureRecord(store: KV | null): void {
	try {
		store?.removeItem(PWA_SYNC_FAILURE_KEY)
	} catch {
		/* nothing to clear */
	}
}

/** Whether the record belongs to this account (the same marker). A changed account is a clear (§六.1). */
export function recordMatchesAccount(record: PwaSyncFailureRecord | null, eoa: string): boolean {
	return record !== null && record.account === accountMarker(eoa)
}

/**
 * v10 §六.2: the manual retry button is shown only when all of these hold: the record exists and matches this account; the last reply
 * was not an envelope-level locked; the page holds a valid mnemonic; and the live walletStatus is not locked (read before rendering).
 */
export function manualRetryVisible(input: {
	hasRecord: boolean
	accountMatches: boolean
	lastReplyEnvelopeLocked: boolean
	hasValidPageMnemonic: boolean
	nativeStatus: string
}): boolean {
	return input.hasRecord && input.accountMatches && !input.lastReplyEnvelopeLocked && input.hasValidPageMnemonic && input.nativeStatus !== 'locked'
}
