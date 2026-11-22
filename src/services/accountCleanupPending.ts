/**
 * and: the cleanup of the previous local storage after the user completes a recovery. The confirmation happens only on the
 * native shell screen; the PWA sends the request and records the pending state only after the native layer answers ok (AppEntryGate).
 * A page-side restore never starts it. The pending marker keeps the new account (never deleted,
 * never treated as "no account") until the native layer answers ok. A `clear_incomplete` answer is resumed with the same idempotencyKey.
 *
 * Recovery-event identity: one idempotencyKey per recovery. A repeat callback of the
 * same recovery (a duplicate, or a restart while pending) reuses that key and is never a second deletion; a new recovery, even one that
 * returns to an earlier account (B→A→B), gets a new key. The done record keeps the latest completed recovery (accountKey and key).
 */
import { runAccountCleanupOld, sendAccountCleanupOld, type AccountCleanupOutcome, type AccountCleanupSend } from './accountCleanupOld'
import { silentCleanupDecision, confirmationAccountKey } from './accountCleanupConfirmation'

/** Accounts whose cleanup is running in this page (a repeated callback never starts a second one). In-memory only. */
const inFlightAccounts = new Set<string>()

export const CLEANUP_PENDING_KEY = 'beamio.accountCleanupOld.pending.v1'
/** The latest completed recovery (accountKey and its idempotencyKey), persisted, so a refresh or restart does not repeat it. */
export const CLEANUP_DONE_KEY = 'beamio.accountCleanupOld.done.v1'

export type CleanupDone = { accountKey: string; idempotencyKey: string }

/** Test helper: clears the in-memory in-flight guard (production never calls it; the done record is in storage). */
export function resetCleanupGuardsForTest(): void {
	inFlightAccounts.clear()
}

/** The latest completed recovery, or null (absent or malformed: never a reason to delete anything). */
export function readCleanupDone(store: Pick<Storage, 'getItem'>): CleanupDone | null {
	try {
		const raw = store.getItem(CLEANUP_DONE_KEY)
		if (!raw) return null
		const d = JSON.parse(raw) as Partial<CleanupDone>
		if (typeof d.accountKey === 'string' && d.accountKey !== '' && typeof d.idempotencyKey === 'string' && d.idempotencyKey !== '') {
			return { accountKey: d.accountKey, idempotencyKey: d.idempotencyKey }
		}
		return null
	} catch {
		return null
	}
}

/**
 * Whether a cleanup must not start for this account now: it is running in this page, or the latest completed recovery is this account (the
 * same recovery's repeat). A later recovery of another account (B→A→B) makes the latest done a different account, so it is not blocked.
 */
export function cleanupBusy(accountKey: string, store?: Pick<Storage, 'getItem'>): boolean {
	const k = accountKey.trim().toLowerCase()
	if (inFlightAccounts.has(k)) return true
	if (store === undefined) return false
	const done = readCleanupDone(store)
	return done !== null && done.accountKey === k
}

export type CleanupPending = { accountKey: string; idempotencyKey: string; keepNewAccount: true }
type PendingStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The pending marker, or null when there is none or it is malformed (a malformed marker is never a reason to delete anything). */
export function readCleanupPending(store: Pick<Storage, 'getItem'>): CleanupPending | null {
	const raw = store.getItem(CLEANUP_PENDING_KEY)
	if (!raw) return null
	try {
		const p = JSON.parse(raw) as Partial<CleanupPending>
		if (typeof p.accountKey === 'string' && p.accountKey !== '' && typeof p.idempotencyKey === 'string' && p.idempotencyKey !== '') {
			return { accountKey: p.accountKey, idempotencyKey: p.idempotencyKey, keepNewAccount: true }
		}
		return null
	} catch {
		return null
	}
}

/** A fresh idempotencyKey. Not security material: it only has to be unique per recovery; it works where randomUUID is absent. */
export function newCleanupIdempotencyKey(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Called after a recovery the native layer confirmed. One idempotencyKey per recovery: a pending marker of the same account is the same
 * recovery and reuses its key (resume); otherwise a new key is generated and persisted before the request. `ok` records the latest done
 * (accountKey and key) and clears the pending marker; any other outcome keeps the pending marker.
 */
export async function startCleanupAfterRecovery(
	store: PendingStore,
	accountKey: string,
	newIdempotencyKey: () => string = newCleanupIdempotencyKey,
	send: AccountCleanupSend = sendAccountCleanupOld,
): Promise<AccountCleanupOutcome> {
	const eoa = accountKey.trim().toLowerCase()
	// a repeat of the latest completed recovery, or a run already in flight, never sends a second command
	if (cleanupBusy(eoa, store)) return { kind: 'incomplete' }
	inFlightAccounts.add(eoa)
	try {
		const existing = readCleanupPending(store)
		const pending: CleanupPending = existing && existing.accountKey === eoa
			? existing
			: { accountKey: eoa, idempotencyKey: newIdempotencyKey(), keepNewAccount: true }
		store.setItem(CLEANUP_PENDING_KEY, JSON.stringify(pending))
		const outcome = await runAccountCleanupOld({ accountKey: pending.accountKey, idempotencyKey: pending.idempotencyKey, send })
		if (outcome.kind === 'ok') {
			// the done record is written before the pending marker is removed: a crash between the two never sends this recovery again
			store.setItem(CLEANUP_DONE_KEY, JSON.stringify({ accountKey: eoa, idempotencyKey: pending.idempotencyKey } satisfies CleanupDone))
			store.removeItem(CLEANUP_PENDING_KEY)
		}
		return outcome
	} finally {
		inFlightAccounts.delete(eoa)
	}
}

/**
 * The silent cleanup after a completed native recovery: reads the page's IDB-derived address once (read-only,
 * through readPageAddress), and starts the cleanup only when the recovery is ok and the two addresses agree (silentCleanupDecision). Any
 * other case (failed, incomplete, unreadable, mismatch, repeat) does nothing and deletes nothing. Returns null when it did not start.
 */
export async function cleanupAfterVerifiedRecovery(
	store: PendingStore,
	nativeAddress: string | null,
	readPageAddress: () => Promise<unknown>,
	send: AccountCleanupSend = sendAccountCleanupOld,
): Promise<AccountCleanupOutcome | null> {
	const pageAddress = await readPageAddress().catch(() => null)
	const key = confirmationAccountKey(pageAddress)
	const decided = silentCleanupDecision({
		nativeRecoveryOk: nativeAddress !== null,
		pageAddress,
		nativeAddress,
		inFlightOrDone: key === null ? true : cleanupBusy(key, store),
	})
	if (decided === null) return null
	return startCleanupAfterRecovery(store, decided, undefined, send)
}
