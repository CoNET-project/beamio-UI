/**
 * The page's passcode documents, keyed per account:
 * database `beamio-passcode-v1`, store `records`; keys `passcodeWrap:<eoa>` (main), `passcodeWrap:<eoa>.staging`, `passcodeAttempt:<eoa>`.
 * `<eoa>` is the lower-case address. Each account has its own keys, so writing one account never reads or touches another account's
 * documents. The legacy single keys (`passcodeWrap`, `passcodeAttempt`, `passcodeWrap.staging`) are never read.
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

export const PASSCODE_DB_NAME = 'beamio-passcode-v1'
export const PASSCODE_STORE = 'records'

/** The per-account keys. `eoa` is lower-cased here, so callers may pass either case. */
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

/** Wrap records for one account, under the account's main key, with the staged write of */
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
export function idbKeyValueDb(dbName: string = PASSCODE_DB_NAME): KeyValueDb {
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
	}
}
