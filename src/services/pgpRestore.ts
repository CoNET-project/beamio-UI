/**
 * plan A (project decision 2026-11-13): the PGP identity of an account is restored from its encrypted backup, and
 * nothing is generated, registered or overwritten on the user's behalf. This module classifies the chain state and holds the
 * failure for the UI. Pure, except for the small store.
 *
 * Failure codes (provisional names, to be confirmed by the interface owner; the spec does not name them yet):
 * - pgp_backup_missing: the record exists (or the local key exists) and the backup is absent.
 * - pgp_backup_undecryptable: the backup is present but cannot be opened with the account key.
 * - pgp_fingerprint_mismatch: the chain holds a different user key than the local key.
 */
import type { OwnChainRead } from './chatOwnRoutePlan'

export type PgpRestoreFailure = 'pgp_backup_missing' | 'pgp_backup_undecryptable' | 'pgp_fingerprint_mismatch' | 'pgp_registration_missing' | 'pgp_restore_not_ready' | 'pgp_verify_failed'

export const PGP_RESTORE_FAILURES: readonly PgpRestoreFailure[] = [
	'pgp_backup_missing',
	'pgp_backup_undecryptable',
	'pgp_fingerprint_mismatch',
	'pgp_registration_missing',
	// the native layer answered not_ready (an inconsistent record, or a locked store). Nothing was written; the user may replace explicitly.
	'pgp_restore_not_ready',
	// pgpRestore failed the native challenge-signature gate: nothing was written. A failure with the user's entry; never an automatic retry.
	'pgp_verify_failed',
]

export function isPgpRestoreFailure(value: unknown): value is PgpRestoreFailure {
	return typeof value === 'string' && (PGP_RESTORE_FAILURES as readonly string[]).includes(value)
}

export type PgpClassification =
	| { kind: 'ok' }
	| { kind: 'new_account' }
	| { kind: 'failure'; code: PgpRestoreFailure }
	| { kind: 'read_error'; reason: string }

const norm = (s: string | undefined | null): string => String(s || '').trim().toUpperCase()

/**
 * Classifies the chain state against the local key.
 * - With a local key (a working account): only a chain user key that differs from it is a failure. Any other state keeps the
 *   account as it is, exactly as before; a missing backup alone does not stop a working key.
 * - Without a local key (a restore): an absent record is a new account; a record whose backup is missing or cannot be opened
 *   is a failure. A failed read is never a failure: it is retried.
 */
export function classifyOwnPgp(input: { read: OwnChainRead; localKeyID: string; hasLocalKey: boolean }): PgpClassification {
	const { read } = input
	if (read.status === 'error') return { kind: 'read_error', reason: read.reason }
	if (input.hasLocalKey) {
		if (read.status === 'ok' && norm(input.localKeyID) && norm(read.userKeyID) !== norm(input.localKeyID)) {
			return { kind: 'failure', code: 'pgp_fingerprint_mismatch' }
		}
		return { kind: 'ok' }
	}
	if (read.status === 'empty') return { kind: 'new_account' }
	if (read.privateBlob === 'missing') return { kind: 'failure', code: 'pgp_backup_missing' }
	if (read.privateBlob === 'undecryptable') return { kind: 'failure', code: 'pgp_backup_undecryptable' }
	if (read.privateBlob === 'error') return { kind: 'read_error', reason: 'private blob read failed' }
	return { kind: 'ok' }
}

/**
 * The chain state as it was when the failure was shown. "生成新 PGP 私钥" is allowed only while the chain is still in this state;
 * a different state stops it, so nothing is overwritten by surprise (decision 2026-11-13).
 */
export function snapshotOfRead(read: OwnChainRead): string {
	if (read.status === 'error') return 'error'
	if (read.status === 'empty') return 'empty'
	return ['ok', norm(read.userKeyID), norm(read.routeKeyID), read.privateBlob].join('|')
}

// Store: the Chat route shows the failure; the wallet pages do not read it.
let failure: PgpRestoreFailure | null = null
let shownSnapshot: string | null = null
const listeners = new Set<(value: PgpRestoreFailure | null) => void>()

export function getPgpRestoreFailure(): PgpRestoreFailure | null {
	return failure
}

export function getPgpRestoreSnapshot(): string | null {
	return shownSnapshot
}

export function setPgpRestoreFailure(next: PgpRestoreFailure | null, shown: string | null = null): void {
	if (next === failure && shown === shownSnapshot) return
	const changed = next !== failure
	failure = next
	shownSnapshot = next ? shown : null
	if (changed) for (const listener of [...listeners]) listener(next)
}

export function subscribePgpRestoreFailure(listener: (value: PgpRestoreFailure | null) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
