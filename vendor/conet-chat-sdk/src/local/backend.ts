/**
 * Storage backend contract for the local chat library, plus an in-memory
 * implementation for Node tests. The IndexedDB implementation lives in idb-backend.ts.
 *
 * Every method is one atomic unit. `writeBatch` is one transaction (spec, ≤200 rows).
 * Keys are blind (conv_blind, cid_blind) and never the plaintext conversation or cid.
 */

import { compareKey } from './codec.js'
import type { LocalLayoutRow, LocalMsgRow } from './types.js'

export type LocalOp =
	| { t: 'put'; row: LocalMsgRow }
	| { t: 'del'; convBlind: string; sortTs: number; stableId: string }
	| { t: 'lput'; row: LocalLayoutRow }
	| { t: 'ldelFor'; convBlind: string; stableId: string }
	| { t: 'aput'; aliasBlind: string; blob: Uint8Array }

export interface LocalBackend {
	getMeta(k: string): Promise<string | null>
	putMeta(k: string, v: string): Promise<void>
	getMsg(convBlind: string, stableId: string): Promise<LocalMsgRow | null>
	findByCid(convBlind: string, cidBlind: string): Promise<LocalMsgRow | null>
	/** Rows with exactly this sort_ts in one conversation (content folding). */
	scanSortTs(convBlind: string, sortTs: number): Promise<LocalMsgRow[]>
	/** Alias record: alias_blind → sealed target stable_id. */
	getAlias(aliasBlind: string): Promise<Uint8Array | null>
	/** Rows strictly before `before` (descending by K), at most `limit`. Tombstones included. */
	scanDesc(convBlind: string, before: { sortTs: number; stableId: string } | null, limit: number): Promise<LocalMsgRow[]>
	/** All rows of one conversation, ascending by K. */
	scanAsc(convBlind: string): Promise<LocalMsgRow[]>
	listConvBlinds(): Promise<string[]>
	countPending(): Promise<number>
	getLayout(convBlind: string, stableId: string, widthBucket: number, orientation: string, fontBucket: number, layoutVersion: number): Promise<LocalLayoutRow | null>
	scanAllLayouts(): Promise<LocalLayoutRow[]>
	writeBatch(ops: LocalOp[]): Promise<void>
	/** Remove every row and meta key. Used by schema rebuild and account deletion. */
	wipe(): Promise<void>
	close(): void
}

const SEP = '\u001f'

/** Shared storage for one in-memory "database"; each open handle points at the same data. */
export class MemoryData {
	meta = new Map<string, string>()
	conv = new Map<string, LocalMsgRow[]>()
	byStable = new Map<string, LocalMsgRow>()
	layouts = new Map<string, LocalLayoutRow>()
	aliases = new Map<string, Uint8Array>()
}

export class MemoryBackend implements LocalBackend {
	private meta: Map<string, string>
	private conv: Map<string, LocalMsgRow[]>
	private byStable: Map<string, LocalMsgRow>
	private layouts: Map<string, LocalLayoutRow>
	private aliases: Map<string, Uint8Array>
	private closed = false

	constructor(data: MemoryData = new MemoryData()) {
		this.meta = data.meta
		this.conv = data.conv
		this.byStable = data.byStable
		this.layouts = data.layouts
		this.aliases = data.aliases
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('backend closed')
	}

	private static layoutKey(convBlind: string, stableId: string, wb: number, o: string, fb: number, lv: number): string {
		return [convBlind, stableId, wb, o, fb, lv].join(SEP)
	}

	async getMeta(k: string): Promise<string | null> {
		this.assertOpen()
		return this.meta.get(k) ?? null
	}

	async putMeta(k: string, v: string): Promise<void> {
		this.assertOpen()
		this.meta.set(k, v)
	}

	async getMsg(convBlind: string, stableId: string): Promise<LocalMsgRow | null> {
		this.assertOpen()
		return this.byStable.get(convBlind + SEP + stableId) ?? null
	}

	async findByCid(convBlind: string, cidBlind: string): Promise<LocalMsgRow | null> {
		this.assertOpen()
		for (const row of this.conv.get(convBlind) ?? []) if (row.cid_blind === cidBlind) return row
		return null
	}

	async scanSortTs(convBlind: string, sortTs: number): Promise<LocalMsgRow[]> {
		this.assertOpen()
		return (this.conv.get(convBlind) ?? []).filter((r) => r.sort_ts === sortTs)
	}

	async getAlias(aliasBlind: string): Promise<Uint8Array | null> {
		this.assertOpen()
		return this.aliases.get(aliasBlind) ?? null
	}

	async scanDesc(convBlind: string, before: { sortTs: number; stableId: string } | null, limit: number): Promise<LocalMsgRow[]> {
		this.assertOpen()
		const rows = this.conv.get(convBlind) ?? []
		let hi = rows.length
		if (before) {
			// first index whose key is >= before; everything below it is strictly earlier
			let lo = 0
			let h = rows.length
			while (lo < h) {
				const mid = (lo + h) >>> 1
				const r = rows[mid]
				if (compareKey(r.sort_ts, r.stable_id, before.sortTs, before.stableId) < 0) lo = mid + 1
				else h = mid
			}
			hi = lo
		}
		const out: LocalMsgRow[] = []
		for (let i = hi - 1; i >= 0 && out.length < limit; i--) out.push(rows[i])
		return out
	}

	async scanAsc(convBlind: string): Promise<LocalMsgRow[]> {
		this.assertOpen()
		return (this.conv.get(convBlind) ?? []).slice()
	}

	async listConvBlinds(): Promise<string[]> {
		this.assertOpen()
		return [...this.conv.keys()]
	}

	async countPending(): Promise<number> {
		this.assertOpen()
		let n = 0
		for (const rows of this.conv.values()) for (const r of rows) if (r.pending_publish === 1) n++
		return n
	}

	async getLayout(convBlind: string, stableId: string, wb: number, o: string, fb: number, lv: number): Promise<LocalLayoutRow | null> {
		this.assertOpen()
		return this.layouts.get(MemoryBackend.layoutKey(convBlind, stableId, wb, o, fb, lv)) ?? null
	}

	async scanAllLayouts(): Promise<LocalLayoutRow[]> {
		this.assertOpen()
		return [...this.layouts.values()]
	}

	async writeBatch(ops: LocalOp[]): Promise<void> {
		this.assertOpen()
		for (const op of ops) {
			if (op.t === 'put') {
				const { row } = op
				const rows = this.conv.get(row.conv_blind) ?? []
				const key = row.conv_blind + SEP + row.stable_id
				const prev = this.byStable.get(key)
				if (prev) {
					// primary key (sort_ts, stable_id) never changes for an existing stable_id (I1)
					const idx = this.indexOf(rows, prev.sort_ts, prev.stable_id)
					if (idx >= 0) rows[idx] = row
				} else {
					const idx = this.insertIndex(rows, row.sort_ts, row.stable_id)
					rows.splice(idx, 0, row)
				}
				this.conv.set(row.conv_blind, rows)
				this.byStable.set(key, row)
			} else if (op.t === 'del') {
				const rows = this.conv.get(op.convBlind) ?? []
				const idx = this.indexOf(rows, op.sortTs, op.stableId)
				if (idx >= 0) {
					const [gone] = rows.splice(idx, 1)
					this.byStable.delete(op.convBlind + SEP + gone.stable_id)
				}
			} else if (op.t === 'lput') {
				const r = op.row
				this.layouts.set(MemoryBackend.layoutKey(r.conv_blind, r.stable_id, r.width_bucket, r.orientation, r.font_bucket, r.layout_version), r)
			} else if (op.t === 'aput') {
				this.aliases.set(op.aliasBlind, op.blob)
			} else {
				const prefix = op.convBlind + SEP + op.stableId + SEP
				for (const k of [...this.layouts.keys()]) if (k.startsWith(prefix)) this.layouts.delete(k)
			}
		}
	}

	async wipe(): Promise<void> {
		this.assertOpen()
		this.meta.clear()
		this.conv.clear()
		this.byStable.clear()
		this.layouts.clear()
		this.aliases.clear()
	}

	close(): void {
		this.closed = true
	}

	private insertIndex(rows: LocalMsgRow[], ts: number, id: string): number {
		let lo = 0
		let hi = rows.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (compareKey(rows[mid].sort_ts, rows[mid].stable_id, ts, id) < 0) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	private indexOf(rows: LocalMsgRow[], ts: number, id: string): number {
		const i = this.insertIndex(rows, ts, id)
		return i < rows.length && rows[i].sort_ts === ts && rows[i].stable_id === id ? i : -1
	}
}
