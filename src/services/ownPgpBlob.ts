/**
 * Read of this account's own PGP private key blob, with the one-time migration to the DEK-local cipher
 *
 * Reading:
 *   - v2 blob  → opened with DEK-local inside the wallet module. Result "ok".
 *   - legacy   → opened once with the legacy method inside the wallet module, then migrated (below).
 *   - absent   → "missing". Unreadable → "undecryptable". Locked wallet → "locked" (nothing is read or written).
 *
 * Migration (one time; repeatable with the same result):
 *   1. Save a state record: the legacy ciphertext as a backup, sealed under DEK-local. Nothing is written before this.
 *   2. Seal the plaintext under DEK-local and check the round trip locally.
 *   3. Write the sealed blob through the registration endpoint (the caller's `writeChain`).
 *   4. Read it back and open it. Only when it matches is the state set to "done", which drops the backup.
 *   On any failure the state stays "pending" with the backup kept. The chain keeps the legacy blob when the write was
 *   refused. The read still returns the value decrypted in this session, and `migrationError` reports the failure.
 *   There is no plaintext fallback: nothing is stored in plaintext.
 *
 * The chain holds one slot per account, so step 3 replaces the legacy ciphertext. The backup in step 1 is what keeps
 * the old copy until the new one is verified.
 */
import { PGP_BLOB_V2_WRITES_ENABLED, isPgpBlobV2 } from './pgpBlob'
import { WalletError } from './walletCore'

export type OwnPgpBlobState = 'ok' | 'missing' | 'undecryptable' | 'locked' | 'error'

export interface OwnPgpBlobResult {
	state: OwnPgpBlobState
	/** The PGP private key armor, when state is "ok". Empty otherwise. */
	armored: string
	/** True when this call wrote the DEK-local blob and verified it. */
	migrated: boolean
	/** Set when a legacy blob was read but the migration did not complete. The read still succeeded. */
	migrationError?: string
}

/** The wallet-module operations this module needs. walletCore implements them. */
export interface OwnPgpBlobCore {
	pgpBlobOpen(accountKey: string, blob: string): Promise<string>
	pgpBlobSeal(accountKey: string, plaintext: string): Promise<string>
	pgpBlobLegacyOpen(accountKey: string, blob: string): Promise<string>
}

export interface OwnPgpBlobDeps {
	core: OwnPgpBlobCore
	accountKey: string
	/** `getEncryptedPrivateKey()` for this account. Throws on an RPC error. Returns "" when absent. */
	readChain(): Promise<string>
	/** Writes the sealed blob through the signed registration. False when the server refuses. Throws on a transport error. */
	writeChain(sealedBlob: string): Promise<boolean>
	/** The sealed state record (opaque), or null. */
	loadState(): Promise<string | null>
	/** Stores the sealed state record. */
	saveState(sealed: string): Promise<void>
	now?: () => number
	/** Whether the migration may write v2. Defaults to the rollout gate (PGP_BLOB_V2_WRITES_ENABLED). */
	writesEnabled?: boolean
}

interface StateRecord {
	v: 1
	state: 'pending' | 'done'
	/** The legacy ciphertext, kept while the state is "pending". Ciphertext only, never plaintext. */
	backup?: string
	attempts: number
	at: number
}

class MigrationError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'MigrationError'
	}
}

/** Errors carry codes only. Nothing from the key or the blob is put in a message. */
const codeOf = (ex: unknown): string => {
	if (ex instanceof MigrationError) return ex.code
	if (ex instanceof WalletError) return ex.code
	return 'error'
}

const inflight = new Map<string, Promise<OwnPgpBlobResult>>()

/** Single-flight per account: concurrent callers share one read and at most one write. */
export function readOwnPgpPrivateArmored(deps: OwnPgpBlobDeps): Promise<OwnPgpBlobResult> {
	const running = inflight.get(deps.accountKey)
	if (running) return running
	const run = doRead(deps).finally(() => {
		inflight.delete(deps.accountKey)
	})
	inflight.set(deps.accountKey, run)
	return run
}

async function doRead(deps: OwnPgpBlobDeps): Promise<OwnPgpBlobResult> {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	const none = (state: OwnPgpBlobState): OwnPgpBlobResult => ({ state, armored: '', migrated: false })
	let blob: string
	try {
		blob = await deps.readChain()
	} catch {
		return none('error')
	}
	if (!blob) return none('missing')

	if (isPgpBlobV2(blob)) {
		try {
			const armored = await deps.core.pgpBlobOpen(deps.accountKey, blob)
			if (!armored.trim()) return none('undecryptable')
			// The chain already holds the verified blob (for example after a read-back that failed earlier):
			// drop a pending backup now, best effort.
			const prev = await loadRecord(deps)
			if (prev?.state === 'pending') {
				try {
					await saveRecord(deps, { v: 1, state: 'done', attempts: prev.attempts, at: (deps.now ?? Date.now)() })
				} catch {
					/* the next read tries again */
				}
			}
			return { state: 'ok', armored, migrated: false }
		} catch (ex) {
			return codeOf(ex) === 'locked' ? none('locked') : none(codeOf(ex) === 'account_mismatch' ? 'error' : 'undecryptable')
		}
	}

	let plain: string
	try {
		plain = await deps.core.pgpBlobLegacyOpen(deps.accountKey, blob)
	} catch (ex) {
		const code = codeOf(ex)
		return code === 'locked' ? none('locked') : code === 'account_mismatch' ? none('error') : none('undecryptable')
	}
	if (!plain.trim()) return none('undecryptable')
	return migrate(deps, blob, plain)
}

async function migrate(deps: OwnPgpBlobDeps, legacyBlob: string, plain: string): Promise<OwnPgpBlobResult> {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	// Rollout gate: while off, nothing is written or saved; the legacy blob stays and the read continues.
	if (!(deps.writesEnabled ?? PGP_BLOB_V2_WRITES_ENABLED)) {
		return { state: 'ok', armored: plain, migrated: false, migrationError: 'write_disabled' }
	}
	const now = deps.now ?? Date.now
	const previous = await loadRecord(deps)
	const attempts = (previous?.attempts ?? 0) + 1
	try {
		// 1. Backup before anything is written.
		await saveRecord(deps, { v: 1, state: 'pending', backup: legacyBlob, attempts, at: now() })

		// 2. New blob, checked locally before it is sent.
		const next = await deps.core.pgpBlobSeal(deps.accountKey, plain)
		if ((await deps.core.pgpBlobOpen(deps.accountKey, next)) !== plain) throw new MigrationError('roundtrip')

		// 3. Write.
		let wrote: boolean
		try {
			wrote = await deps.writeChain(next)
		} catch {
			throw new MigrationError('write_failed')
		}
		if (!wrote) throw new MigrationError('write_refused')

		// 4. Read back and verify before the backup is dropped.
		let back: string
		try {
			back = await deps.readChain()
		} catch {
			throw new MigrationError('readback_failed')
		}
		let verified = false
		if (isPgpBlobV2(back)) {
			try {
				verified = (await deps.core.pgpBlobOpen(deps.accountKey, back)) === plain
			} catch {
				verified = false
			}
		}
		if (!verified) throw new MigrationError('readback_failed')

		// 5. Done: the backup is removed.
		await saveRecord(deps, { v: 1, state: 'done', attempts, at: now() })
		return { state: 'ok', armored: plain, migrated: true }
	} catch (ex) {
		return { state: 'ok', armored: plain, migrated: false, migrationError: codeOf(ex) }
	}
}

async function saveRecord(deps: OwnPgpBlobDeps, rec: StateRecord): Promise<void> {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	await deps.saveState(await deps.core.pgpBlobSeal(deps.accountKey, JSON.stringify(rec)))
}

/** A record that cannot be opened is treated as absent (the migration is then simply repeated). */
async function loadRecord(deps: OwnPgpBlobDeps): Promise<StateRecord | null> {
	if (process.env.REACT_APP_SHELL_BUILD === 'true') throw new Error('pgp_not_in_shell') // Boundary: own-PGP reads are not built into a shell; the native SDK reads them.
	try {
		const sealed = await deps.loadState()
		if (!sealed) return null
		const rec = JSON.parse(await deps.core.pgpBlobOpen(deps.accountKey, sealed)) as StateRecord
		return rec && rec.v === 1 ? rec : null
	} catch {
		return null
	}
}

/**
 * Browser store for the sealed state record: one IndexedDB database, one key per account. Only sealed text is stored.
 */
export function indexedDbStateStore(accountKey: string): Pick<OwnPgpBlobDeps, 'loadState' | 'saveState'> {
	const DB = 'beamio-pgp-blob-v1'
	const STORE = 'state'
	const open = (): Promise<IDBDatabase> =>
		new Promise((resolve, reject) => {
			const req = indexedDB.open(DB, 1)
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
			}
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(new MigrationError('state_unavailable'))
		})
	return {
		async loadState() {
			const db = await open()
			try {
				return await new Promise<string | null>((resolve, reject) => {
					const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(accountKey)
					q.onsuccess = () => resolve(typeof q.result === 'string' ? q.result : null)
					q.onerror = () => reject(new MigrationError('state_unavailable'))
				})
			} finally {
				db.close()
			}
		},
		async saveState(sealed: string) {
			const db = await open()
			try {
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE, 'readwrite')
					tx.objectStore(STORE).put(sealed, accountKey)
					tx.oncomplete = () => resolve()
					tx.onerror = () => reject(new MigrationError('state_unavailable'))
					tx.onabort = () => reject(new MigrationError('state_unavailable'))
				})
			} finally {
				db.close()
			}
		},
	}
}
