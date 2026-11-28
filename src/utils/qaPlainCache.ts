/**
 * read-only counts for the question "where does the first copy after a reload come from, and is there plaintext on disk in library mode".
 * It opens the chat SDK worker's own IndexedDB (`beamio-chat-sdk`, store `kv`, vendor/conet-chat-sdk worker/entry.ts) READ-ONLY and counts the keys that start with the plaintext history cache prefix. It returns a NUMBER:
 * no key, no value, no content, no id leaves. -1 when the database cannot be read. Every call site is `if (QA_ACK_ORDER_HOOK)`, so a production bundle contains none of it.
 */
export const QA_PLAIN_CACHE_PREFIX = 'beamio.chat.history.plain:'
export const QA_WORKER_DB = 'beamio-chat-sdk'
export const QA_WORKER_STORE = 'kv'

export function qaPlainCacheKeyCount(idb: Pick<IDBFactory, 'open'> | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): Promise<number> {
	return countPrefix(idb, QA_PLAIN_CACHE_PREFIX)
}

function countPrefix(idb: Pick<IDBFactory, 'open'> | undefined, prefix: string): Promise<number> {
	return new Promise<number>((resolve) => {
		if (!idb) { resolve(-1); return }
		let req: IDBOpenDBRequest
		try { req = idb.open(QA_WORKER_DB) } catch { resolve(-1); return }
		req.onerror = () => resolve(-1)
		req.onupgradeneeded = () => { try { req.transaction?.abort() } catch { /* nothing is created: the database did not exist */ } }
		req.onsuccess = () => {
			const db = req.result
			try {
				if (!db.objectStoreNames.contains(QA_WORKER_STORE)) { db.close(); resolve(0); return }
				const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
				const count = db.transaction(QA_WORKER_STORE, 'readonly').objectStore(QA_WORKER_STORE).count(range)
				count.onsuccess = () => { db.close(); resolve(Number(count.result) || 0) }
				count.onerror = () => { db.close(); resolve(-1) }
			} catch {
				try { db.close() } catch { /* ignore */ }
				resolve(-1)
			}
		}
	})
}

/**
 * The EOA of the account, from the first candidate that holds one: the address the chat client is BOUND to (boundAccountOfActiveClient: the EOA the worker was started with, the one its plaintext keys carry), then the
 * stored profile's keyID. A keyID is not always a bare address (r8hook3 smoke: `profiles[0].keyID` was not `0x` + 40 hex, so the clear answered `no_account`), so the FIRST `0x` + 40 hex inside a candidate counts
 * (a bare address, `eoa:workspace`, a checksummed one); anything without one is skipped. Returns lower case, or '' when no candidate holds an address.
 */
export function qaOwnerEoaOf(candidates: ReadonlyArray<unknown>): string {
	for (const c of candidates) {
		if (typeof c !== 'string') continue
		const m = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/.exec(c)
		if (m) return m[0].toLowerCase()
	}
	return ''
}

/**
 * The worker's purge of the legacy plaintext keys logs ONE line with counts only: `[local] legacy plain purge status=.. reason=.. keys=N rows=N inserted=N present=N junk=N removed=N remaining=N`. In the hook
 * variant the page turns it into two events the QA state line shows: `plain_purge` (status and reason words) and `plain_purge_n` (`k<keys>_j<junk>_i<inserted>_r<removed>_l<left>`; a left count of -1 is `lm1`), so `junk` can be
 * read on a real account. Any other message gives no event. Numbers and plain words only.
 */
export function qaPlainPurgeEventsOf(message: unknown): Array<{ name: string; detail: string }> {
	const m = /^\[local\] legacy plain purge status=([a-z_]+) reason=([a-z_0-9]*) keys=(\d+) rows=(\d+) inserted=(\d+) present=(\d+) junk=(\d+) removed=(\d+) remaining=(-?\d+)$/.exec(String(message))
	if (!m) return []
	return [
		{ name: 'plain_purge', detail: `${m[1]}${m[2] ? `_${m[2]}` : ''}` },
		{ name: 'plain_purge_n', detail: `k${m[3]}_j${m[7]}_i${m[5]}_r${m[8]}_l${m[9].replace('-', 'm')}` },
	]
}

/** the account whose plaintext cache the QA clear acts on: a getter registered by the App (the account's address, lower case), nothing else */
let ownerGetter: (() => string) | null = null
export function qaSetPlainCacheOwner(get: (() => string) | null): void { ownerGetter = get }

export type QaPlainCacheClearResult = { ok: true; before: number; after: number } | { ok: false; reason: 'no_account' | 'unreadable' | 'delete_failed' }

/**
 * the QA control round for the first-copy question. Deletes ONLY the plaintext history-cache keys of ONE account (`beamio.chat.history.plain:<eoa>:`...) from the worker's
 * IndexedDB, directly by key range (the worker's persistence has no keys interface), in one readwrite transaction; the library, the account record and every other key are not touched. The count of that account's plaintext keys is
 * read before and after, from a fresh read-only transaction (the number is the evidence that the delete happened); only numbers leave. `ok:false` says why (no account / database unreadable / delete failed).
 */
export async function qaClearPlainCache(eoaLower: string, idb: Pick<IDBFactory, 'open'> | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): Promise<QaPlainCacheClearResult> {
	const eoa = String(eoaLower || '').trim().toLowerCase()
	if (!/^0x[0-9a-f]{40}$/.test(eoa)) return { ok: false, reason: 'no_account' }
	if (!idb) return { ok: false, reason: 'unreadable' }
	const prefix = `${QA_PLAIN_CACHE_PREFIX}${eoa}:`
	const before = await countPrefix(idb, prefix)
	if (before < 0) return { ok: false, reason: 'unreadable' }
	if (before > 0) {
		const deleted = await new Promise<boolean>((resolve) => {
			let req: IDBOpenDBRequest
			try { req = idb.open(QA_WORKER_DB) } catch { resolve(false); return }
			req.onerror = () => resolve(false)
			req.onupgradeneeded = () => { try { req.transaction?.abort() } catch { /* the database did not exist */ } }
			req.onsuccess = () => {
				const db = req.result
				try {
					const tx = db.transaction(QA_WORKER_STORE, 'readwrite')
					tx.objectStore(QA_WORKER_STORE).delete(IDBKeyRange.bound(prefix, `${prefix}￿`))
					tx.oncomplete = () => { db.close(); resolve(true) }
					tx.onerror = () => { db.close(); resolve(false) }
					tx.onabort = () => { db.close(); resolve(false) }
				} catch {
					try { db.close() } catch { /* ignore */ }
					resolve(false)
				}
			}
		})
		if (!deleted) return { ok: false, reason: 'delete_failed' }
	}
	const after = await countPrefix(idb, prefix)
	if (after < 0) return { ok: false, reason: 'unreadable' }
	return { ok: true, before, after }
}

/** the clear for the registered account, with the number event; the page keeps working with or without the answer */
export async function qaClearPlainCacheForOwner(emit?: (name: string, detail: string) => void): Promise<QaPlainCacheClearResult> {
	let eoa = ''
	try { eoa = ownerGetter ? ownerGetter() : '' } catch { eoa = '' }
	const r = await qaClearPlainCache(eoa)
	emit?.('plain_cache_cleared', r.ok ? `b${r.before}_a${r.after}` : `fail_${r.reason}`)
	return r
}
