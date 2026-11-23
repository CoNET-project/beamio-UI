/**
 * Local wallet database compatibility (2026-11-18, owner decision: option 5, narrow and feature-detected).
 *
 * Problem (reproduced in WebKit with a short-lived context):
 * PouchDB 9's IndexedDB setup runs one readwrite transaction over meta-store, detect-blob-support and document-store. It issues the
 * meta-store read first, then writes an empty Blob to detect-blob-support (checkBlobSupport). In a short-lived WebKit context that Blob
 * write fails with UnknownError, and the earlier read in the same transaction never settles, so every PouchDB call hangs and the
 * entry gate times out ("storage unavailable"). The storage itself works (a bare indexedDB.open succeeds in about 2 ms).
 *
 * What this module does, and only this:
 *  1. Probe once per page, in a separate one-off database that is deleted afterwards, whether an empty Blob can be written at all.
 *     Success: nothing changes (ordinary Safari, Chrome and PWA behaviour). An open failure or hang: the storage is genuinely unavailable,
 *     nothing is installed, and the read reports it as unavailable.
 *  2. Only when the Blob write itself fails or hangs, install a narrow shim: a put into the object store named
 *     'detect-blob-support' whose value is a Blob throws DataCloneError synchronously. PouchDB's checkBlobSupport catches that inside its
 *     Promise executor and resolves false (= no Blob support, attachments stored as base64). No request is left pending, so the
 *     transaction completes. Every other put is passed through unchanged.
 * The wallet document ('init') holds text, not attachments (see beamio.ts: storageHashData, putDocDurable), so base64 storage is not a
 * data-format change for it. Nothing is deleted, migrated or rewritten.
 */

export const BLOB_PROBE_DB_NAME = 'beamio-idb-blob-probe-v1'
export const BLOB_PROBE_OPEN_MS = 2_000
export const BLOB_PROBE_WRITE_MS = 2_000
export const POUCH_BLOB_PROBE_STORE = 'detect-blob-support'

export type IdbBlobCompatOutcome =
	| 'no_idb'
	| 'blob_supported'
	| 'storage_unavailable'
	| 'shim_installed'
	/** The probe write neither succeeded nor failed within the limit. No conclusion: nothing is installed, the original path runs, and the
	 * existing gate timeout decides availability (2026-11-18 rule). Not storage_unavailable, not shim_installed. */
	| 'probe_inconclusive'

type ShimMarker = { __beamioBlobShim?: true }

/** The narrow put shim. Exported for the unit tests; the production install is installDetectBlobShim(). */
export function makeDetectBlobPutShim(
	originalPut: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest,
	isBlob: (v: unknown) => boolean,
): ((this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest) & ShimMarker {
	const shim = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
		if (this.name === POUCH_BLOB_PROBE_STORE && isBlob(value)) {
			// Synchronous throw: PouchDB's checkBlobSupport executor rejects, its .catch resolves false, and no request stays pending.
			throw new DOMException('Blob writes to the PouchDB probe store are not supported in this environment', 'DataCloneError')
		}
		return arguments.length >= 2 ? originalPut.call(this, value, key) : originalPut.call(this, value)
	}
	;(shim as typeof shim & ShimMarker).__beamioBlobShim = true
	return shim as typeof shim & ShimMarker
}

/** Installs the shim on IDBObjectStore.prototype.put once. Returns false when already installed or when IDB is absent. */
export function installDetectBlobShim(target: { prototype: IDBObjectStore } | undefined = typeof IDBObjectStore !== 'undefined' ? IDBObjectStore : undefined): boolean {
	if (!target) return false
	const proto = target.prototype as unknown as { put: ((this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest) & ShimMarker }
	if (proto.put.__beamioBlobShim) return false
	const original = proto.put
	proto.put = makeDetectBlobPutShim(original, (v) => typeof Blob !== 'undefined' && v instanceof Blob)
	return true
}

/** Times a promise; resolves `fallback` when it does not settle in time (the late settlement is ignored). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms)
		p.then(
			(v) => { clearTimeout(timer); resolve(v) },
			() => { clearTimeout(timer); resolve(fallback) },
		)
	})
}

type ProbeDeps = { idb: IDBFactory | undefined; isBlob: (v: unknown) => boolean; newBlob: () => unknown; install: () => boolean }

/**
 * The probe itself, parameterised for tests. Returns the outcome; never throws.
 * storage_unavailable: indexedDB.open failed or did not settle; nothing is installed.
 * shim_installed: the empty Blob write failed (a request error or a synchronous throw); the shim is installed.
 * blob_supported: the empty Blob write succeeded; nothing is installed.
 * probe_inconclusive: the empty Blob write did not settle within the limit; nothing is installed (a hang is not a failure).
 */
export async function runIdbBlobProbe(deps: ProbeDeps): Promise<IdbBlobCompatOutcome> {
	const idb = deps.idb
	if (!idb) return 'no_idb'
	const opened = await within<IDBDatabase | null>(
		new Promise<IDBDatabase>((resolve, reject) => {
			const req = idb.open(BLOB_PROBE_DB_NAME, 1)
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains('probe')) req.result.createObjectStore('probe')
			}
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
			req.onblocked = () => reject(new Error('blocked'))
		}),
		BLOB_PROBE_OPEN_MS,
		null,
	)
	if (!opened) return 'storage_unavailable'
	let writeResult: 'ok' | 'error' | 'timeout' = 'timeout'
	try {
		writeResult = await within<'ok' | 'error' | 'timeout'>(
			new Promise<'ok' | 'error'>((resolve) => {
				let req: IDBRequest
				try {
					const tx = opened.transaction('probe', 'readwrite')
					req = tx.objectStore('probe').put(deps.newBlob(), 'key')
				} catch {
					resolve('error')
					return
				}
				req.onsuccess = () => resolve('ok')
				req.onerror = (e) => { e.preventDefault(); resolve('error') }
			}),
			BLOB_PROBE_WRITE_MS,
			'timeout',
		)
	} finally {
		try { opened.close() } catch { /* ignore */ }
		// one-off database: removed again; a deletion that never settles is left alone (it holds no wallet data)
		void within(
			new Promise<void>((resolve) => {
				const d = idb.deleteDatabase(BLOB_PROBE_DB_NAME)
				d.onsuccess = () => resolve()
				d.onerror = () => resolve()
				d.onblocked = () => resolve()
			}),
			BLOB_PROBE_OPEN_MS,
			undefined,
		)
	}
	if (writeResult === 'ok') return 'blob_supported'
	if (writeResult === 'timeout') return 'probe_inconclusive'
	deps.install()
	return 'shim_installed'
}

let readyPromise: Promise<IdbBlobCompatOutcome> | null = null

/** Memoised per page: every local-wallet database access awaits this before PouchDB is created. */
export function idbBlobCompatReady(): Promise<IdbBlobCompatOutcome> {
	if (!readyPromise) {
		const p: Promise<IdbBlobCompatOutcome> = runIdbBlobProbe({
			idb: typeof indexedDB !== 'undefined' ? indexedDB : undefined,
			isBlob: (v) => typeof Blob !== 'undefined' && v instanceof Blob,
			newBlob: () => new Blob(['']),
			install: () => installDetectBlobShim(),
		}).catch(() => 'storage_unavailable' as const)
		readyPromise = p
		// storage_unavailable is not kept: the next access (for example the gate's Retry) probes again, so a transient failure can clear.
		void p.then((o) => { if (o === 'storage_unavailable' && readyPromise === p) readyPromise = null })
	}
	return readyPromise
}

/** Test seam: forget the memoised probe (unit tests only). */
export function resetIdbBlobCompatForTests(): void {
	readyPromise = null
}
