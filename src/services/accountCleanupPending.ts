/**
 * Y.91 and Y.100: the cleanup of the previous local storage after the user completes a recovery. The confirmation happens only on the
 * native shell screen; the PWA sends the request and records the pending state. The pending marker keeps the new account (never deleted,
 * never treated as "no account") until the native layer answers ok. A `clear_incomplete` answer is resumed with the same idempotencyKey.
 */
import { runAccountCleanupOld, sendAccountCleanupOld, type AccountCleanupOutcome, type AccountCleanupSend } from './accountCleanupOld'

export const CLEANUP_PENDING_KEY = 'beamio.accountCleanupOld.pending.v1'

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

/**
 * Called after a recovery the user completed and the native layer confirmed. The pending marker is written before the request, so an
 * interrupted run resumes. The same pending key is reused for the same account. `ok` clears the marker; any other outcome keeps it.
 */
export async function startCleanupAfterRecovery(
	store: PendingStore,
	accountKey: string,
	newIdempotencyKey: () => string = () => globalThis.crypto.randomUUID(),
	send: AccountCleanupSend = sendAccountCleanupOld,
): Promise<AccountCleanupOutcome> {
	const eoa = accountKey.trim().toLowerCase()
	const existing = readCleanupPending(store)
	const pending: CleanupPending = existing && existing.accountKey === eoa
		? existing
		: { accountKey: eoa, idempotencyKey: newIdempotencyKey(), keepNewAccount: true }
	store.setItem(CLEANUP_PENDING_KEY, JSON.stringify(pending))
	const outcome = await runAccountCleanupOld({ accountKey: pending.accountKey, idempotencyKey: pending.idempotencyKey, send })
	if (outcome.kind === 'ok') store.removeItem(CLEANUP_PENDING_KEY)
	return outcome
}
