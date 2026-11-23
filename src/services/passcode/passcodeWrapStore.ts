/**
 * The page's passcode documents, keyed per account (r2c §二, frozen §9.2 with the per-account keys):
 *   database `beamio-passcode-v1`, store `records`; keys `passcodeWrap:<eoa>` (main), `passcodeWrap:<eoa>.staging`, `passcodeAttempt:<eoa>`.
 * `<eoa>` is the lower-case address. Each account has its own keys, so writing one account never reads or touches another account's
 * documents (frozen §10). The legacy single keys (`passcodeWrap`, `passcodeAttempt`, `passcodeWrap.staging`) are never read (r2e §一).
 * It is NOT part of the legacy init document: persistInitRecord, cacheStorageBackup and the PGP strip rules never touch these keys.
 *
 * Write: stage first, read back and compare, then replace the main record and delete the staging copy. A failed readback deletes the
 * staging copy and keeps the main record byte-for-byte. A staging copy with no main record is never promoted automatically; it shows
 * "identity pending" and is kept. A malformed record throws (unknown); it is never read as absent or as zero attempts.
 */
import type { AttemptState, AttemptStore } from './passcodeBackoff'
import { isWrapRecord, type WrapRecord } from './walletWrap'

/** A minimal key-value document store. Production uses IndexedDB (idbKeyValueDb); tests use an in-memory one. */
export interface KeyValueDb {
	get(key: string): Promise<unknown>
	put(key: string, value: unknown): Promise<void>
	delete(key: string): Promise<void>
}

/** A key-value store with one atomic read-modify-write (IndexedDB: a single readwrite transaction). Used for the cooldown record. */
export interface AtomicKeyValueDb extends KeyValueDb {
	/**
	 * `fn` gets the stored value (undefined when absent) and returns the next value; null deletes the key. Atomic across tabs.
	 * Resolves with the value read back INSIDE the same transaction (undefined when absent), so another tab's later write cannot be
	 * mistaken for a failed write.
	 */
	update(key: string, fn: (prev: unknown) => unknown): Promise<unknown>
}

/** The cooldown record of one account (unit f3, 2026-11-22): the count, the lock end and the last failure. Never a passcode or a key. */
export interface AttemptRecordStore {
	/** The stored record (null when none). Throws on a read failure or a malformed record. */
	read(): Promise<AttemptState | null>
	/**
	 * Atomic update: `fn` decides the next state from the stored one (null clears and deletes the record). The write is read back;
	 * a mismatch or a failed read throws, so the caller refuses the attempt. Returns the state read back.
	 */
	update(fn: (prev: AttemptState | null) => AttemptState | null): Promise<AttemptState | null>
}

export const PASSCODE_DB_NAME = 'beamio-passcode-v1'
export const PASSCODE_STORE = 'records'

/** The per-account keys (r2c §二.1). `eoa` is lower-cased here, so callers may pass either case. */
export const mainKey = (eoa: string): string => `passcodeWrap:${eoa.toLowerCase()}`
export const stagingKey = (eoa: string): string => `passcodeWrap:${eoa.toLowerCase()}.staging`
export const attemptKey = (eoa: string): string => `passcodeAttempt:${eoa.toLowerCase()}`

export interface WrapDoc {
	eoa: string
	wraps: Record<string, WrapRecord>
}

const isWrapDoc = (x: unknown): x is WrapDoc => {
	const d = x as WrapDoc | null
	if (!d || typeof d !== 'object' || typeof d.eoa !== 'string' || !d.wraps || typeof d.wraps !== 'object') return false
	return Object.values(d.wraps).every((r) => isWrapRecord(r))
}

const isAttemptState = (x: unknown): x is AttemptState => {
	const r = x as AttemptState | null
	return (
		!!r &&
		typeof r === 'object' &&
		Number.isSafeInteger(r.failures) &&
		r.failures >= 0 &&
		Number.isSafeInteger(r.lockedUntilMs) &&
		r.lockedUntilMs >= 0 &&
		Number.isSafeInteger(r.lastFailureMs) &&
		r.lastFailureMs >= 0
	)
}

/** The attempt counter for one account. Missing reads as null (no attempts); a malformed document throws (unknown). */
export function passcodeAttemptStore(db: KeyValueDb, eoa: string): AttemptStore {
	const lower = eoa.toLowerCase()
	const key = attemptKey(lower)
	return {
		async read() {
			const v = (await db.get(key)) as (AttemptState & { eoa?: string }) | undefined | null
			if (v === undefined || v === null) return null
			if (!isAttemptState(v) || v.eoa !== lower) throw new Error('passcode_attempt_malformed')
			return { failures: v.failures, lockedUntilMs: v.lockedUntilMs, lastFailureMs: v.lastFailureMs }
		},
		async write(state: AttemptState) {
			await db.put(key, { eoa: lower, failures: state.failures, lockedUntilMs: state.lockedUntilMs, lastFailureMs: state.lastFailureMs })
		},
	}
}

/** Wrap records for one account, under the account's main key, with the staged write of §9.2. */
export function passcodeWrapStore(db: KeyValueDb, eoa: string) {
	const lower = eoa.toLowerCase()
	const main = mainKey(lower)
	const staging = stagingKey(lower)

	/** The main record for this account: null when absent; throws when malformed. */
	const readMain = async (): Promise<WrapDoc | null> => {
		const v = await db.get(main)
		if (v === undefined || v === null) return null
		if (!isWrapDoc(v) || v.eoa !== lower) throw new Error('passcode_wrap_malformed')
		return v
	}

	return {
		async readWrap(field: string): Promise<WrapRecord | null> {
			const doc = await readMain()
			return doc ? doc.wraps[field] ?? null : null
		},

		/** True when a staged copy exists while the main record is absent. Such a copy is never promoted automatically. */
		async identityPending(): Promise<boolean> {
			const m = await db.get(main)
			const s = await db.get(staging)
			return (m === undefined || m === null) && s !== undefined && s !== null
		},

		async writeWrap(field: string, rec: WrapRecord): Promise<void> {
			if (!isWrapRecord(rec)) throw new Error('passcode_wrap_malformed')
			const current = (await readMain()) ?? { eoa: lower, wraps: {} }
			const next: WrapDoc = { eoa: lower, wraps: { ...current.wraps, [field]: rec } }
			try {
				await db.put(staging, next)
			} catch {
				throw new Error('write_failed')
			}
			let back: unknown
			try {
				back = await db.get(staging)
			} catch {
				await db.delete(staging).catch(() => undefined)
				throw new Error('write_failed')
			}
			if (JSON.stringify(back) !== JSON.stringify(next)) {
				await db.delete(staging).catch(() => undefined)
				throw new Error('readback_mismatch')
			}
			try {
				await db.put(main, next)
			} catch {
				// the main record keeps its old bytes; the staged copy stays for the next start (not promoted here)
				throw new Error('write_failed')
			}
			await db.delete(staging)
		},
	}
}

/** Production adapter: one IndexedDB database `beamio-passcode-v1`, one store `records`. Not exercised by tests (no IndexedDB in jsdom). */
export function idbKeyValueDb(dbName: string = PASSCODE_DB_NAME): AtomicKeyValueDb {
	const open = (): Promise<IDBDatabase> =>
		new Promise((resolve, reject) => {
			const req = indexedDB.open(dbName, 1)
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(PASSCODE_STORE)) req.result.createObjectStore(PASSCODE_STORE)
			}
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(new Error('passcode_db_open_failed'))
		})
	const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
		const db = await open()
		try {
			return await new Promise<T>((resolve, reject) => {
				const tx = db.transaction(PASSCODE_STORE, mode)
				const req = fn(tx.objectStore(PASSCODE_STORE))
				tx.oncomplete = () => resolve(req.result)
				tx.onerror = () => reject(new Error('passcode_db_tx_failed'))
				tx.onabort = () => reject(new Error('passcode_db_tx_aborted'))
			})
		} finally {
			db.close()
		}
	}
	return {
		get: (key) => run<unknown>('readonly', (s) => s.get(key)),
		put: async (key, value) => {
			await run<IDBValidKey>('readwrite', (s) => s.put(value, key))
		},
		delete: async (key) => {
			await run<undefined>('readwrite', (s) => s.delete(key))
		},
		update: async (key, fn) => {
			const db = await open()
			try {
				return await new Promise<unknown>((resolve, reject) => {
					const tx = db.transaction(PASSCODE_STORE, 'readwrite')
					const store = tx.objectStore(PASSCODE_STORE)
					const get = store.get(key)
					let readBack: unknown = undefined
					get.onsuccess = () => {
						try {
							const next = fn(get.result)
							if (next === null) store.delete(key)
							else store.put(next, key)
							// the read-back is part of this transaction: it sees this write and nothing another tab writes later
							const rb = store.get(key)
							rb.onsuccess = () => {
								readBack = rb.result
							}
						} catch (ex) {
							tx.abort()
							reject(ex instanceof Error ? ex : new Error('passcode_db_update_failed'))
						}
					}
					tx.oncomplete = () => resolve(readBack)
					tx.onerror = () => reject(new Error('passcode_db_tx_failed'))
					tx.onabort = () => reject(new Error('passcode_db_tx_aborted'))
				})
			} finally {
				db.close()
			}
		},
	}
}

/**
 * The cooldown record for one account, in the same passcode store (key `passcodeAttempt:<eoa>`). A cleared record is deleted.
 * Every change is one atomic transaction, so two tabs cannot lose a count. The write is read back before the caller may show a result.
 */
export function passcodeAttemptRecordStore(db: AtomicKeyValueDb, eoa: string): AttemptRecordStore {
	const lower = eoa.toLowerCase()
	const key = attemptKey(lower)
	const fromDoc = (v: unknown): AttemptState | null => {
		if (v === undefined || v === null) return null
		const r = v as AttemptState & { eoa?: string }
		if (!isAttemptState(r) || r.eoa !== lower) throw new Error('passcode_attempt_malformed')
		return { failures: r.failures, lockedUntilMs: r.lockedUntilMs, lastFailureMs: r.lastFailureMs }
	}
	const toDoc = (s: AttemptState) => ({ eoa: lower, failures: s.failures, lockedUntilMs: s.lockedUntilMs, lastFailureMs: s.lastFailureMs })
	return {
		async read() {
			return fromDoc(await db.get(key))
		},
		async update(fn) {
			let written: AttemptState | null = null
			const readBack = await db.update(key, (prev) => {
				const next = fn(fromDoc(prev))
				written = next
				return next === null ? null : toDoc(next)
			})
			const back = fromDoc(readBack)
			if (JSON.stringify(back) !== JSON.stringify(written)) throw new Error('attempt_readback_mismatch')
			return back
		},
	}
}

/** Test double (never used in production): an atomic in-memory store. Updates are queued, as IndexedDB serialises readwrite transactions. */
export function memoryAtomicKeyValueDb(): AtomicKeyValueDb & { raw: Map<string, unknown> } {
	const raw = new Map<string, unknown>()
	let queue: Promise<unknown> = Promise.resolve()
	const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
	return {
		raw,
		async get(k) {
			return clone(raw.get(k))
		},
		async put(k, v) {
			raw.set(k, clone(v))
		},
		async delete(k) {
			raw.delete(k)
		},
		update(k, fn) {
			const run = queue.then(() => {
				const next = fn(clone(raw.get(k)))
				if (next === null) raw.delete(k)
				else raw.set(k, clone(next))
				return clone(raw.get(k))
			})
			queue = run.catch(() => undefined)
			return run
		},
	}
}
