/**
 * IndexedDB backend for the local chat library.
 * One database per account: `beamio-chat-local-v1-<sha256(accountKey)[0:16]>` (one library per account).
 * Object stores: meta (key k), msg (key [conv_blind, sort_ts, stable_id]), layout (key [conv_blind, stable_id, wb, o, fb, lv]).
 */

import type { LocalBackend, LocalOp } from './backend.js'
import type { LocalLayoutRow, LocalMsgRow } from './types.js'

const STORE_META = 'meta'
const STORE_MSG = 'msg'
const STORE_LAYOUT = 'layout'
const STORE_ALIAS = 'alias'
const IDX_STABLE = 'msg_id_uq'
const IDX_CID = 'msg_cid'

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result)
		r.onerror = () => reject(r.error)
	})
}

function done(t: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
	})
}

export function openIdbBackend(dbName: string): Promise<IdbBackend> {
	return new Promise((resolve, reject) => {
		// version 2 adds the alias store
		const open = indexedDB.open(dbName, 2)
		open.onupgradeneeded = () => {
			const db = open.result
			if (!db.objectStoreNames.contains(STORE_ALIAS)) db.createObjectStore(STORE_ALIAS)
			if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
			if (!db.objectStoreNames.contains(STORE_MSG)) {
				const ms = db.createObjectStore(STORE_MSG)
				ms.createIndex(IDX_STABLE, ['conv_blind', 'stable_id'], { unique: true })
				ms.createIndex(IDX_CID, ['conv_blind', 'cid_blind'], { unique: false })
			}
			if (!db.objectStoreNames.contains(STORE_LAYOUT)) db.createObjectStore(STORE_LAYOUT)
		}
		open.onsuccess = () => resolve(new IdbBackend(open.result))
		open.onerror = () => reject(open.error)
	})
}

export class IdbBackend implements LocalBackend {
	constructor(private db: IDBDatabase) {}

	async getMeta(k: string): Promise<string | null> {
		const t = this.db.transaction([STORE_META], 'readonly')
		const v = await req(t.objectStore(STORE_META).get(k))
		return typeof v === 'string' ? v : null
	}

	async putMeta(k: string, v: string): Promise<void> {
		const t = this.db.transaction([STORE_META], 'readwrite')
		t.objectStore(STORE_META).put(v, k)
		await done(t)
	}

	async getMsg(convBlind: string, stableId: string): Promise<LocalMsgRow | null> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const row = await req(t.objectStore(STORE_MSG).index(IDX_STABLE).get([convBlind, stableId]))
		return (row as LocalMsgRow | undefined) ?? null
	}

	async findByCid(convBlind: string, cidBlind: string): Promise<LocalMsgRow | null> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const row = await req(t.objectStore(STORE_MSG).index(IDX_CID).get([convBlind, cidBlind]))
		return (row as LocalMsgRow | undefined) ?? null
	}

	async scanSortTs(convBlind: string, sortTs: number): Promise<LocalMsgRow[]> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const range = IDBKeyRange.bound([convBlind, sortTs, ''] as IDBValidKey, [convBlind, sortTs, '\uffff'] as IDBValidKey)
		return (await req(t.objectStore(STORE_MSG).getAll(range))) as LocalMsgRow[]
	}

	async getAlias(aliasBlind: string): Promise<Uint8Array | null> {
		const t = this.db.transaction([STORE_ALIAS], 'readonly')
		const v = await req(t.objectStore(STORE_ALIAS).get(aliasBlind))
		return v instanceof Uint8Array ? v : null
	}

	async scanDesc(convBlind: string, before: { sortTs: number; stableId: string } | null, limit: number): Promise<LocalMsgRow[]> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const store = t.objectStore(STORE_MSG)
		const lower = [convBlind, -Infinity, '']
		const upper = before ? [convBlind, before.sortTs, before.stableId] : [convBlind, Infinity, '￿']
		const range = IDBKeyRange.bound(lower as IDBValidKey, upper as IDBValidKey, false, before ? true : false)
		const out: LocalMsgRow[] = []
		await new Promise<void>((resolve, reject) => {
			const cur = store.openCursor(range, 'prev')
			cur.onsuccess = () => {
				const c = cur.result
				if (!c || out.length >= limit) return resolve()
				out.push(c.value as LocalMsgRow)
				c.continue()
			}
			cur.onerror = () => reject(cur.error)
		})
		return out
	}

	async scanAsc(convBlind: string): Promise<LocalMsgRow[]> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const range = IDBKeyRange.bound([convBlind, -Infinity, ''] as IDBValidKey, [convBlind, Infinity, '￿'] as IDBValidKey)
		return (await req(t.objectStore(STORE_MSG).getAll(range))) as LocalMsgRow[]
	}

	async listConvBlinds(): Promise<string[]> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const keys = (await req(t.objectStore(STORE_MSG).getAllKeys())) as unknown[]
		const set = new Set<string>()
		for (const k of keys) if (Array.isArray(k) && typeof k[0] === 'string') set.add(k[0])
		return [...set]
	}

	async countRows(): Promise<number> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		return (await req(t.objectStore(STORE_MSG).count())) as number
	}

	async countPending(): Promise<number> {
		const t = this.db.transaction([STORE_MSG], 'readonly')
		const rows = (await req(t.objectStore(STORE_MSG).getAll())) as LocalMsgRow[]
		return rows.reduce((n, r) => n + (r.pending_publish === 1 ? 1 : 0), 0)
	}

	async getLayout(convBlind: string, stableId: string, wb: number, o: string, fb: number, lv: number): Promise<LocalLayoutRow | null> {
		const t = this.db.transaction([STORE_LAYOUT], 'readonly')
		const row = await req(t.objectStore(STORE_LAYOUT).get([convBlind, stableId, wb, o, fb, lv]))
		return (row as LocalLayoutRow | undefined) ?? null
	}

	async scanAllLayouts(): Promise<LocalLayoutRow[]> {
		const t = this.db.transaction([STORE_LAYOUT], 'readonly')
		return (await req(t.objectStore(STORE_LAYOUT).getAll())) as LocalLayoutRow[]
	}

	async writeBatch(ops: LocalOp[]): Promise<void> {
		if (!ops.length) return
		const t = this.db.transaction([STORE_MSG, STORE_LAYOUT, STORE_ALIAS], 'readwrite')
		const ms = t.objectStore(STORE_MSG)
		const ls = t.objectStore(STORE_LAYOUT)
		const as = t.objectStore(STORE_ALIAS)
		for (const op of ops) {
			if (op.t === 'aput') as.put(op.blob, op.aliasBlind)
			else if (op.t === 'put') ms.put(op.row, [op.row.conv_blind, op.row.sort_ts, op.row.stable_id])
			else if (op.t === 'del') ms.delete([op.convBlind, op.sortTs, op.stableId])
			else if (op.t === 'lput') {
				const r = op.row
				ls.put(r, [r.conv_blind, r.stable_id, r.width_bucket, r.orientation, r.font_bucket, r.layout_version])
			} else {
				ls.delete(IDBKeyRange.bound([op.convBlind, op.stableId] as IDBValidKey, [op.convBlind, op.stableId, []] as IDBValidKey))
			}
		}
		await done(t)
	}

	async wipe(): Promise<void> {
		const t = this.db.transaction([STORE_META, STORE_MSG, STORE_LAYOUT, STORE_ALIAS], 'readwrite')
		t.objectStore(STORE_META).clear()
		t.objectStore(STORE_MSG).clear()
		t.objectStore(STORE_LAYOUT).clear()
		t.objectStore(STORE_ALIAS).clear()
		await done(t)
	}

	close(): void {
		this.db.close()
	}
}
