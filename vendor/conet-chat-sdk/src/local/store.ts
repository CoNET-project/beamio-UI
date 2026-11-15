/**
 * Local chat library (interface –). Encrypted at rest, keyed by
 * (sort_ts, stable_id), with a read path that never touches the network.
 *
 * Writers (ingest, sync, layout writes, clear, send-path marks) run one at a time through `serial`.
 * Readers (openConversation, loadOlder) read the backend only.
 */

import { hkdf } from '../crypto.js'
import {
	cidBlindOf,
	convBlindOf,
	deriveLocalKeys,
	kcvOf,
	layoutKeyBlindOf,
	sendKeyFromRecord,
	stableIdFromSendKey,
} from './keys.js'
import {
	AesKey,
	base64url,
	compareKey,
	fromBase64url,
	hmacSha256,
	isUuid,
	joinFields,
	sha256Hex,
	toHex,
	textOf,
	utf8,
	zeroize,
} from './codec.js'
import type { LocalBackend, LocalOp } from './backend.js'
import {
	EstimateCorrections,
	LAYOUT_VERSION,
	estimate,
	layoutKeyOf,
	measurementChanged,
	type LayoutKey,
	type LayoutValue,
} from './layout.js'
import type {
	ChatItem,
	ClearResult,
	IncomingRecord,
	IngestOutcome,
	LocalEvent,
	LocalLayoutRow,
	LocalMeta,
	LocalMsgRow,
	MediaInfo,
	PageResult,
	SyncStats,
	Viewport,
} from './types.js'

const SCHEMA_VERSION = 1
/** Safety cap on visible rows per page. Normal viewports never reach it. */
const PAGE_CAP = 200
/** Raw rows per scan chunk. */
const SCAN_CHUNK = 64
/** Raw rows scanned per call before the scan gives up. */
const SCAN_BUDGET = 2000
const SEP = '\u001f'

export interface SyncRecord {
	convKey: string
	dir: 'in' | 'out'
	sortTs: number
	sendId?: string | null
	/** Explicit sendKey when the index already carries it. */
	sendKey?: string
	cid: string | null
	revision?: number
}

export interface SyncOptions {
	/** Rows per transaction. Default 200. */
	batch?: number
	/** Concurrent fetch/decrypt calls. Default 6. */
	concurrency?: number
}

/** cursor body: base64url(JSON{v:1, e: dbEpoch[0:8], c: convKey, t: sort_ts, i: stable_id}). */
interface Cursor {
	v: number
	e: string
	c: string
	t: number
	i: string
}

interface Before {
	sortTs: number
	stableId: string
}

interface Pick {
	row: LocalMsgRow
	meta: LocalMeta | null
	lay: LayoutValue
}

const newEpoch = (): string => toHex((globalThis.crypto as Crypto).getRandomValues(new Uint8Array(16)))

function encodeCursor(epoch: string, convKey: string, row: { sort_ts: number; stable_id: string }): string {
	const c: Cursor = { v: 1, e: epoch.slice(0, 8), c: convKey.toLowerCase(), t: row.sort_ts, i: row.stable_id }
	return base64url(utf8(JSON.stringify(c)))
}

function decodeCursor(cursor: string): Cursor | null {
	try {
		const c = JSON.parse(textOf(fromBase64url(cursor))) as Cursor
		if (c.v !== 1 || typeof c.e !== 'string' || typeof c.c !== 'string' || typeof c.t !== 'number' || typeof c.i !== 'string') return null
		return c
	} catch {
		return null
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0)
	const out = new Uint8Array(total)
	let off = 0
	for (const p of parts) {
		out.set(p, off)
		off += p.length
	}
	return out
}

export class LocalChatStore {
	private backend: LocalBackend | null = null
	private dek: AesKey | null = null
	private dekRaw: Uint8Array | null = null
	private idKey: Uint8Array | null = null
	private idxKey: Uint8Array | null = null
	private state: 'closed' | 'open' | 'locked' = 'closed'
	private lastCode: string | null = null
	private dbEpoch = ''
	/** Incremented on lock and on clear; reads started before it are discarded. */
	private generation = 0
	private chain: Promise<unknown> = Promise.resolve()
	private overlay = new Map<string, LocalMsgRow>()
	private corr = new EstimateCorrections()
	private syncState: PageResult['syncState'] = 'idle'
	private listeners = new Set<(ev: LocalEvent) => void>()
	readonly stats = { layoutHits: 0, layoutMisses: 0, writes: 0, decryptFailures: 0, sendKeyConflict: 0, legacyUuidFetched: 0, folded: 0 }

	/**
	 * @param openBackend factory for the per-account backend (IndexedDB in the browser, memory in tests).
	 */
	constructor(private readonly openBackend: () => Promise<LocalBackend>) {}

	get status(): { state: 'closed' | 'open' | 'locked'; code: string | null } {
		return { state: this.state, code: this.lastCode }
	}

	setSyncState(s: PageResult['syncState']): void {
		this.syncState = s
	}

	/** Change and lifecycle events (–6.5). */
	subscribe(handler: (ev: LocalEvent) => void): () => void {
		this.listeners.add(handler)
		return () => this.listeners.delete(handler)
	}

	private emit(ev: LocalEvent): void {
		for (const h of this.listeners) {
			try {
				h(ev)
			} catch {
				/* isolate subscribers */
			}
		}
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn)
		this.chain = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	// ---- open / lock ------------------------------------------------------

	/**
	 * Open the account library with the master key. DEK and the blind-index keys are derived in memory only (D1).
	 * kcv mismatch: rebuild when nothing is pending, otherwise stay locked.
	 */
	/** Open from the root (tests and the wallet layer). The storage layer itself only needs the subkeys. */
	async open(rDb: Uint8Array, eoa: string, workspace: string): Promise<{ state: 'open' | 'locked'; code: string | null }> {
		const keys = await deriveLocalKeys(rDb, eoa, workspace)
		return this.openWithKeys(keys)
	}

	/**
	 * Open with the subkeys K_id, K_idx and DEK (condition 2). The caller keeps its own copies; the store
	 * copies the bytes it needs and zeroizes its copies on lock.
	 */
	async openWithKeys(keys: { kId: Uint8Array; kIdx: Uint8Array; dek: Uint8Array }): Promise<{ state: 'open' | 'locked'; code: string | null }> {
		return this.serial(async () => {
			this.closeInternal()
			const dekRaw = keys.dek.slice()
			const idRaw = keys.kId.slice()
			const idxRaw = keys.kIdx.slice()
			const kcv = await kcvOf(dekRaw)
			const backend = await this.openBackend()
			const schema = await backend.getMeta('schemaVersion')
			if (schema !== null && Number(schema) > SCHEMA_VERSION) {
				backend.close()
				zeroize(dekRaw)
				zeroize(idRaw)
				zeroize(idxRaw)
				this.setLocked('schema_newer')
				return { state: 'locked' as const, code: 'schema_newer' }
			}
			const stored = await backend.getMeta('kcv')
			const fresh = async () => {
				await backend.putMeta('kcv', kcv)
				await backend.putMeta('schemaVersion', String(SCHEMA_VERSION))
				await backend.putMeta('layoutVersion', String(LAYOUT_VERSION))
				await backend.putMeta('dbEpoch', newEpoch())
				await backend.putMeta('syncComplete', '0')
				await backend.putMeta('migrationState', 'none')
			}
			if (stored === null) {
				await fresh()
			} else if (stored !== kcv) {
				//  (supersedes the  rebuild): a key that does not match returns kcv_mismatch.
				// Nothing is written and nothing is wiped. A rebuild is only the explicit deleteLocalData action.
				backend.close()
				zeroize(dekRaw)
				zeroize(idRaw)
				zeroize(idxRaw)
				this.setLocked('kcv_mismatch')
				return { state: 'locked' as const, code: 'kcv_mismatch' }
			}
			this.backend = backend
			this.dekRaw = dekRaw
			this.dek = await AesKey.importRaw(dekRaw)
			this.idKey = idRaw
			this.idxKey = idxRaw
			this.dbEpoch = (await backend.getMeta('dbEpoch')) ?? ''
			await this.pruneStaleLayouts(backend)
			this.state = 'open'
			this.lastCode = null
			return { state: 'open' as const, code: null }
		})
	}

	private setLocked(code: string): void {
		this.generation++
		this.state = 'locked'
		this.lastCode = code
		this.backend = null
		this.dek = null
		this.dekRaw = null
		this.idKey = null
		this.idxKey = null
		this.overlay.clear()
	}

	/**
	 * Lock (D2): generation first, then the UI is told to clear, then keys are zeroed and the
	 * handle is closed. The library file stays on disk, encrypted.
	 */
	lock(): void {
		this.generation++
		this.emit({ kind: 'locked' })
		this.closeInternal()
		this.state = 'locked'
		this.lastCode = null
	}

	private closeInternal(): void {
		this.backend?.close()
		this.backend = null
		this.dek = null
		if (this.dekRaw) zeroize(this.dekRaw)
		if (this.idKey) zeroize(this.idKey)
		if (this.idxKey) zeroize(this.idxKey)
		this.dekRaw = null
		this.idKey = null
		this.idxKey = null
		this.dbEpoch = ''
		this.overlay.clear()
		this.state = 'closed'
	}

	/** Delete the account contents (删除本地数据). Caller confirms first. */
	async deleteLocalData(): Promise<void> {
		await this.serial(async () => {
			this.generation++
			// The explicit reset works from any state, including a key mismatch: it opens the file itself.
			const backend = this.backend ?? (await this.openBackend())
			await backend.wipe()
			backend.close()
			this.closeInternal()
		})
	}

	private async pruneStaleLayouts(backend: LocalBackend): Promise<void> {
		const stale = (await backend.scanAllLayouts()).filter((r) => r.layout_version !== LAYOUT_VERSION)
		if (!stale.length) return
		const ops: LocalOp[] = stale.map((r) => ({ t: 'ldelFor', convBlind: r.conv_blind, stableId: r.stable_id }))
		await backend.writeBatch(ops)
	}

	// ---- identity ------------------------------------------------

	private async convBlindOf(convKey: string): Promise<string> {
		//a conversation key is the lowercase address
		return convBlindOf(this.idxKey!, convKey.toLowerCase())
	}

	private async cidBlindOf(cid: string): Promise<string> {
		return cidBlindOf(this.idxKey!, cid)
	}

	/** sendKey: the sendId when it is usable; otherwise a deterministic derivation from the body. */
	private async sendKeyOf(rec: { convKey: string; dir: 'in' | 'out'; sortTs: number; body: string; sendId?: string | null; sendKey?: string }): Promise<string> {
		if (rec.sendKey) return rec.sendKey
		return sendKeyFromRecord(this.idKey!, rec)
	}

	/** stable_id: base64url(HMAC(K_idx, sendKey)), 43 ASCII characters. */
	private async stableIdOf(sendKey: string): Promise<string> {
		return stableIdFromSendKey(this.idxKey!, sendKey)
	}

	/** The sendKey and stable_id a record gets on this device (migration and tests). */
	async sendKeyFor(rec: IncomingRecord): Promise<string> {
		return this.sendKeyOf(rec)
	}

	async stableIdFor(rec: IncomingRecord): Promise<string> {
		return this.stableIdOf(await this.sendKeyOf(rec))
	}

	/** Blind index of a conversation key (public for migration and tests). */
	async conversationBlind(convKey: string): Promise<string> {
		return this.convBlindOf(convKey)
	}

	// ---- seal / open ------------------------------------------------

	private sealBody(cb: string, stable: string, revision: number, body: string): Promise<Uint8Array> {
		return this.dek!.seal(joinFields(cb, stable, revision), utf8(body))
	}

	private sealMeta(cb: string, stable: string, meta: LocalMeta): Promise<Uint8Array> {
		return this.dek!.seal(joinFields(cb, stable), utf8(JSON.stringify(meta)))
	}

	private async openMetaRow(row: LocalMsgRow): Promise<LocalMeta | null> {
		if (!row.meta_enc) return null
		try {
			return JSON.parse(textOf(await this.dek!.open(joinFields(row.conv_blind, row.stable_id), row.meta_enc))) as LocalMeta
		} catch {
			this.stats.decryptFailures++
			return null
		}
	}

	private async openBodyRow(row: LocalMsgRow): Promise<string | undefined> {
		if (!row.body_enc) return undefined
		try {
			return textOf(await this.dek!.open(joinFields(row.conv_blind, row.stable_id, row.revision), row.body_enc))
		} catch {
			this.stats.decryptFailures++
			return undefined
		}
	}

	private async layoutAad(cb: string, stable: string, k: LayoutKey): Promise<Uint8Array> {
		return joinFields(cb, stable, await layoutKeyBlindOf(this.idxKey!, `${k.wb}|${k.o}|${k.fb}|${k.lv}`))
	}

	private async openLayoutRow(row: LocalLayoutRow): Promise<{ wPt: number; hPt: number } | null> {
		try {
			const k: LayoutKey = { wb: row.width_bucket, o: row.orientation, fb: row.font_bucket, lv: row.layout_version }
			return JSON.parse(textOf(await this.dek!.open(await this.layoutAad(row.conv_blind, row.stable_id, k), row.val_enc))) as { wPt: number; hPt: number }
		} catch {
			this.stats.decryptFailures++
			return null
		}
	}

	// ---- lookups with batch overlay ----------------------------------------

	private async lookup(cb: string, stable: string): Promise<LocalMsgRow | null> {
		const o = this.overlay.get(cb + SEP + stable)
		if (o) return o
		return this.backend!.getMsg(cb, stable)
	}

	private setOverlay(row: LocalMsgRow): void {
		this.overlay.set(row.conv_blind + SEP + row.stable_id, row)
	}

	// ---- write planning -------------------------------------

	/**
	 * Decide what one incoming record does and append the ops. Does not write.
	 * Rules:  (conflicts keep the first body),  (revision, tombstone, ts),  (layout invalidation).
	 */
	private async plan(rec: IncomingRecord, ops: LocalOp[]): Promise<{ outcome: IngestOutcome; tsMismatch: boolean; stable: string }> {
		const cb = await this.convBlindOf(rec.convKey)
		const sk = await this.sendKeyOf(rec)
		let stable = await this.stableIdOf(sk)
		const cidB = rec.cid ? await this.cidBlindOf(rec.cid) : null
		const revision = rec.revision ?? 0
		let existing = await this.lookup(cb, stable)
		if (!existing) {
			// a folded sendKey resolves to its survivor
			const target = await this.resolveAlias(sk)
			if (target) {
				stable = target
				existing = await this.lookup(cb, stable)
			}
		}
		const done = (outcome: IngestOutcome, tsMismatch: boolean) => ({ outcome, tsMismatch, stable })

		if (existing) {
			const tsMismatch = existing.sort_ts !== rec.sortTs
			if (existing.deleted === 1) return done('skipped', tsMismatch) // a tombstone is terminal
			if (rec.deleted) {
				if (revision < existing.revision) return done('skipped', tsMismatch)
				const row: LocalMsgRow = {
					...existing,
					deleted: 1,
					body_enc: null,
					meta_enc: null,
					revision: Math.max(existing.revision, revision),
					pending_publish: 0,
					cid_blind: cidB ?? existing.cid_blind,
				}
				ops.push({ t: 'put', row }, { t: 'ldelFor', convBlind: cb, stableId: stable })
				this.setOverlay(row)
				return done('deleted', tsMismatch)
			}
			if (revision > existing.revision) {
				const prevMeta = await this.openMetaRow(existing)
				const bh = await sha256Hex(utf8(rec.body))
				const row: LocalMsgRow = {
					...existing,
					revision,
					kind: rec.kind,
					cid_blind: cidB ?? existing.cid_blind,
					body_enc: await this.sealBody(cb, stable, revision, rec.body),
					meta_enc: await this.sealMeta(cb, stable, { sk, bh, media: rec.media ?? prevMeta?.media }),
				}
				ops.push({ t: 'put', row }, { t: 'ldelFor', convBlind: cb, stableId: stable })
				this.setOverlay(row)
				return done('updated', tsMismatch)
			}
			if (revision < existing.revision) return done('skipped', tsMismatch) // stale copy: never moves cid back (D-A2)
			// same revision from here on
			const bh = await sha256Hex(utf8(rec.body))
			if (existing.body_enc === null) {
				const row: LocalMsgRow = {
					...existing,
					kind: rec.kind,
					cid_blind: cidB ?? existing.cid_blind,
					body_enc: await this.sealBody(cb, stable, existing.revision, rec.body),
					meta_enc: await this.sealMeta(cb, stable, { sk, bh, media: rec.media }),
				}
				ops.push({ t: 'put', row })
				this.setOverlay(row)
				return done('updated', tsMismatch)
			}
			const prevMeta = await this.openMetaRow(existing)
			if (prevMeta && prevMeta.bh !== bh) {
				//same sendKey, different body at the same revision → keep the first, count it
				this.stats.sendKeyConflict++
				return done('conflict', tsMismatch)
			}
			if (cidB && existing.cid_blind !== cidB) {
				// PWA relinearize: only the ciphertext id moved; body and layout stay
				const row: LocalMsgRow = { ...existing, cid_blind: cidB }
				ops.push({ t: 'put', row })
				this.setOverlay(row)
				return done('recid', tsMismatch)
			}
			return done('skipped', tsMismatch)
		}

		//  content folding: the same (peer, dir, ts, SHA256(body)) under another sendKey is the same message.
		// The earliest arrival survives; the other sendKey becomes an alias to it.
		if (!rec.deleted) {
			const bh = await sha256Hex(utf8(rec.body))
			const survivor = await this.findFoldSurvivor(cb, rec.dir, rec.sortTs, bh)
			if (survivor) {
				const aliasBlind = base64url(await hmacSha256(this.idxKey!, utf8(sk)))
				const blob = await this.dek!.seal(utf8(aliasBlind), utf8(survivor.stable_id))
				ops.push({ t: 'aput', aliasBlind, blob })
				this.stats.folded++
				return done('folded', false)
			}
		}

		// new row: sort_ts is fixed at first write (I1)
		if (rec.deleted) {
			const row: LocalMsgRow = {
				conv_blind: cb,
				stable_id: stable,
				sort_ts: rec.sortTs,
				dir: rec.dir,
				kind: rec.kind,
				revision,
				deleted: 1,
				pending_publish: 0,
				cid_blind: cidB,
				body_enc: null,
				meta_enc: null,
			}
			ops.push({ t: 'put', row }, { t: 'ldelFor', convBlind: cb, stableId: stable })
			this.setOverlay(row)
			return done('deleted', false)
		}
		const bh = await sha256Hex(utf8(rec.body))
		const row: LocalMsgRow = {
			conv_blind: cb,
			stable_id: stable,
			sort_ts: rec.sortTs,
			dir: rec.dir,
			kind: rec.kind,
			revision,
			deleted: 0,
			pending_publish: rec.pending ? 1 : 0,
			cid_blind: cidB,
			body_enc: await this.sealBody(cb, stable, revision, rec.body),
			meta_enc: await this.sealMeta(cb, stable, { sk, bh, media: rec.media }),
		}
		ops.push({ t: 'put', row })
		this.setOverlay(row)
		return done('inserted', false)
	}

	/** The survivor stable_id for a folded sendKey, or null. */
	private async resolveAlias(sk: string): Promise<string | null> {
		const aliasBlind = base64url(await hmacSha256(this.idxKey!, utf8(sk)))
		const blob = await this.backend!.getAlias(aliasBlind)
		if (!blob) return null
		try {
			return textOf(await this.dek!.open(utf8(aliasBlind), blob))
		} catch {
			this.stats.decryptFailures++
			return null
		}
	}

	/** An existing live row with the same peer, direction, ts and body hash, earliest first. */
	private async findFoldSurvivor(cb: string, dir: 'in' | 'out', sortTs: number, bh: string): Promise<LocalMsgRow | null> {
		const stored = await this.backend!.scanSortTs(cb, sortTs)
		const pending = [...this.overlay.values()].filter((r) => r.conv_blind === cb && r.sort_ts === sortTs)
		for (const c of [...stored, ...pending]) {
			if (c.deleted === 1 || c.dir !== dir) continue
			const m = await this.openMetaRow(c)
			if (m && m.bh === bh) return c
		}
		return null
	}

	private async flush(ops: LocalOp[], events: Array<{ convKey: string; outcome: IngestOutcome; stableId: string; sortTs: number }>): Promise<void> {
		this.overlay.clear()
		if (ops.length) {
			await this.backend!.writeBatch(ops)
			this.stats.writes += ops.length
		}
		for (const e of events) this.emit({ kind: 'changed', ...e })
	}

	/** Ingest one decrypted record (send path, append path, or a single write). Same serial queue as sync. */
	async ingest(rec: IncomingRecord): Promise<IngestOutcome> {
		return this.serial(async () => {
			if (this.state !== 'open') return 'locked' as const
			const ops: LocalOp[] = []
			try {
				const { outcome, stable } = await this.plan(rec, ops)
				await this.flush(ops, outcome === 'skipped' ? [] : [{ convKey: rec.convKey.toLowerCase(), outcome, stableId: stable, sortTs: rec.sortTs }])
				return outcome
			} finally {
				this.overlay.clear()
			}
		})
	}

	// ---- full sync -----------------------------------------------------

	/**
	 * Sync index records into the library. `fetch` returns the decrypted record or null.
	 * Records already present with a body are skipped without download or decrypt. Writes use the same
	 * serial queue as ingest; reads are not blocked.
	 */
	async syncRecords(records: SyncRecord[], fetch: (rec: SyncRecord) => Promise<IncomingRecord | null>, opts: SyncOptions = {}): Promise<SyncStats> {
		const batch = opts.batch ?? 200
		const concurrency = opts.concurrency ?? 6
		const stats: SyncStats = { records: records.length, skipped: 0, fetched: 0, recid: 0, failed: 0, tsMismatch: 0, sendKeyConflict: 0, legacyUuidFetched: 0, folded: 0 }
		const conflictsBefore = this.stats.sendKeyConflict
		this.setSyncState('running')
		try {
			for (let off = 0; off < records.length; off += batch) {
				const slice = records.slice(off, off + batch)
				// first pass, outside the writer lock: decide who needs a download (steps 1–2)
				const need: SyncRecord[] = []
				const recidOnly: Array<{ cb: string; stable: string; cidB: string }> = []
				for (const rec of slice) {
					const verdict = await this.settleCheck(rec)
					if (verdict === 'skip') stats.skipped++
					else if (verdict === 'fetch') need.push(rec)
					else recidOnly.push(verdict)
				}
				// fetch with bounded concurrency
				const fetched: Array<IncomingRecord | null> = new Array(need.length).fill(null)
				let cursor = 0
				const worker = async () => {
					while (cursor < need.length) {
						const i = cursor++
						try {
							fetched[i] = await fetch(need[i])
						} catch {
							fetched[i] = null
						}
					}
				}
				await Promise.all(Array.from({ length: Math.min(concurrency, need.length) }, worker))
				// second pass, under the writer lock
				await this.serial(async () => {
					if (this.state !== 'open') return
					const ops: LocalOp[] = []
					const events: Array<{ convKey: string; outcome: IngestOutcome; stableId: string; sortTs: number }> = []
					try {
						for (const r of recidOnly) {
							const row = await this.backend!.getMsg(r.cb, r.stable)
							if (row) {
								const next = { ...row, cid_blind: r.cidB }
								ops.push({ t: 'put', row: next })
								this.setOverlay(next)
								stats.recid++
							}
						}
						for (let i = 0; i < fetched.length; i++) {
							const inc = fetched[i]
							if (!inc) {
								stats.failed++
								continue
							}
							stats.fetched++
							const { outcome, tsMismatch, stable } = await this.plan(inc, ops)
							if (tsMismatch) stats.tsMismatch++
							if (outcome === 'skipped') stats.skipped++
							else events.push({ convKey: inc.convKey.toLowerCase(), outcome, stableId: stable, sortTs: inc.sortTs })
						}
						await this.flush(ops, events)
					} finally {
						this.overlay.clear()
					}
				})
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			stats.sendKeyConflict = this.stats.sendKeyConflict - conflictsBefore
			this.setSyncState('idle')
			return stats
		} catch (ex) {
			this.setSyncState('error')
			throw ex
		}
	}

	/**
	 *  steps 1–2: 'skip' when the library already has the body, a recid-only update when only the cid moved,
	 * otherwise 'fetch'.
	 */
	private async settleCheck(rec: SyncRecord): Promise<'skip' | 'fetch' | { cb: string; stable: string; cidB: string }> {
		if (this.state !== 'open') return 'skip'
		const cb = await this.convBlindOf(rec.convKey)
		const cidB = rec.cid ? await this.cidBlindOf(rec.cid) : null
		const directSk = rec.sendKey ?? (rec.sendId ? rec.sendId : null)
		let existing: LocalMsgRow | null
		if (directSk) {
			existing = await this.backend!.getMsg(cb, await this.stableIdOf(directSk))
			if (!existing) {
				const target = await this.resolveAlias(directSk)
				if (target) existing = await this.backend!.getMsg(cb, target)
			}
		} else {
			// sendless or legacy UUID: the body is needed to derive the sendKey, so match by cid
			existing = cidB ? await this.backend!.findByCid(cb, cidB) : null
		}
		if (!existing) return 'fetch'
		const rev = rec.revision ?? 0
		const settled = existing.deleted === 1 || (rev <= existing.revision && existing.body_enc !== null)
		if (!settled) return 'fetch'
		if (existing.deleted === 0 && cidB && existing.cid_blind !== cidB && rev === existing.revision) {
			return { cb, stable: existing.stable_id, cidB }
		}
		return 'skip'
	}

	// ---- reads (–6.4) ------------------------------------------------

	private emptyPage(source: PageResult['source'], olderState: PageResult['olderState']): PageResult {
		return { items: [], olderCursor: null, olderState, scanExhausted: false, syncState: this.syncState, source, short: true, capped: false }
	}

	private sourceNow(): PageResult['source'] | null {
		if (this.state !== 'open') return 'locked'
		return null
	}

	async openConversation(convKey: string, vp: Viewport): Promise<PageResult> {
		return this.readPage(convKey, null, vp)
	}

	/** Strictly older than `cursor`. Throws `cursor_invalid` for another epoch or another conversation. */
	async loadOlder(convKey: string, cursor: string, vp: Viewport): Promise<PageResult> {
		const c = decodeCursor(cursor)
		if (!c || c.e !== this.dbEpoch.slice(0, 8) || c.c !== convKey.toLowerCase()) {
			const err = new Error('cursor_invalid') as Error & { code?: string }
			err.code = 'cursor_invalid'
			throw err
		}
		return this.readPage(convKey, { sortTs: c.t, stableId: c.i }, vp)
	}

	private async isSyncComplete(): Promise<boolean> {
		return (await this.backend!.getMeta('syncComplete')) === '1'
	}

	/**
	 * –6.4: accumulate visible height from `before` (newest when null) until it reaches heightPt;
	 * the row that crosses the line is included. Tombstones count as 0pt and are skipped.
	 * `olderState` comes from an n+1 probe and `syncComplete`.
	 */
	private async readPage(convKey: string, before: Before | null, vp: Viewport): Promise<PageResult> {
		const blocked = this.sourceNow()
		if (blocked) return this.emptyPage(blocked, 'pending')
		const gen = this.generation
		const backend = this.backend!
		const cb = await this.convBlindOf(convKey)
		const picked: Pick[] = []
		let sum = 0
		let lastExamined: LocalMsgRow | null = null
		let cur = before
		let rowsScanned = 0
		let originalsExhausted = false
		let scanExhausted = false
		let capped = false
		outer: for (;;) {
			if (rowsScanned >= SCAN_BUDGET) {
				scanExhausted = picked.length === 0
				break
			}
			const batch = await backend.scanDesc(cb, cur, SCAN_CHUNK)
			if (!batch.length) {
				originalsExhausted = true
				break
			}
			for (const row of batch) {
				rowsScanned++
				lastExamined = row
				cur = { sortTs: row.sort_ts, stableId: row.stable_id }
				if (row.deleted === 1) continue
				const meta = await this.openMetaRow(row)
				const lay = await this.layoutOf(row, meta, vp)
				picked.push({ row, meta, lay })
				sum += lay.hPt
				if (sum >= vp.heightPt) break outer
				if (picked.length >= PAGE_CAP) {
					capped = true
					break outer
				}
			}
			if (batch.length < SCAN_CHUNK) {
				originalsExhausted = true
				break
			}
		}
		if (gen !== this.generation) return this.emptyPage('locked', 'pending')

		if (scanExhausted) {
			// The budget ran out without a visible item: the UI must ask again, never read this as the end
			const at = lastExamined ?? null
			return {
				items: [],
				olderCursor: at ? encodeCursor(this.dbEpoch, convKey, at) : before ? encodeCursor(this.dbEpoch, convKey, { sort_ts: before.sortTs, stable_id: before.stableId }) : null,
				olderState: 'more',
				scanExhausted: true,
				syncState: this.syncState,
				source: 'local',
				short: false,
				capped: false,
			}
		}

		let olderState: PageResult['olderState']
		let olderCursor: string | null = null
		if (!lastExamined) {
			olderState = (await this.isSyncComplete()) ? 'end' : 'pending'
			olderCursor = before ? encodeCursor(this.dbEpoch, convKey, { sort_ts: before.sortTs, stable_id: before.stableId }) : null
		} else {
			const probe = await backend.scanDesc(cb, { sortTs: lastExamined.sort_ts, stableId: lastExamined.stable_id }, 1)
			if (probe.length > 0) {
				olderState = 'more'
				olderCursor = encodeCursor(this.dbEpoch, convKey, lastExamined)
			} else if (await this.isSyncComplete()) {
				olderState = 'end'
			} else {
				olderState = 'pending'
				olderCursor = encodeCursor(this.dbEpoch, convKey, lastExamined)
			}
		}
		const items: ChatItem[] = []
		for (let i = picked.length - 1; i >= 0; i--) items.push(await this.toItem(picked[i]))
		const short = originalsExhausted && sum < vp.heightPt
		return { items, olderCursor, olderState, scanExhausted: false, syncState: this.syncState, source: 'local', short, capped }
	}

	private async layoutOf(row: LocalMsgRow, meta: LocalMeta | null, vp: Viewport): Promise<LayoutValue> {
		const k = layoutKeyOf(vp)
		const hit = await this.backend!.getLayout(row.conv_blind, row.stable_id, k.wb, k.o, k.fb, k.lv)
		if (hit) {
			const v = await this.openLayoutRow(hit)
			if (v) {
				this.stats.layoutHits++
				return { wPt: v.wPt, hPt: v.hPt, measured: true }
			}
		}
		this.stats.layoutMisses++
		return estimate({ kind: row.kind, widthPx: meta?.media?.widthPx, heightPx: meta?.media?.heightPx, mediaState: meta?.media?.state }, vp, this.corr)
	}

	private async toItem(p: Pick): Promise<ChatItem> {
		const { row, meta, lay } = p
		const item: ChatItem = {
			stableId: row.stable_id,
			sortTs: row.sort_ts,
			dir: row.dir,
			kind: row.kind,
			revision: row.revision,
			layout: { wPt: lay.wPt, hPt: lay.hPt, measured: lay.measured },
		}
		if (row.kind === 'text' || row.kind === 'system') item.body = await this.openBodyRow(row)
		if (meta?.media) {
			const m: MediaInfo = meta.media
			item.media = { mime: m.mime, widthPx: m.widthPx, heightPx: m.heightPx, state: m.state ?? 'pending' }
		}
		return item
	}

	// ---- layout records ----------------------------------------------

	/** Store a real measurement (encrypted value). Estimates are never passed here. */
	async reportLayout(convKey: string, stableId: string, vp: Viewport, wPt: number, hPt: number): Promise<{ written: boolean }> {
		return this.serial(async () => {
			if (this.state !== 'open') return { written: false }
			const cb = await this.convBlindOf(convKey)
			const row = await this.backend!.getMsg(cb, stableId)
			if (!row || row.deleted === 1) return { written: false }
			const k = layoutKeyOf(vp)
			const meta = await this.openMetaRow(row)
			const est = estimate({ kind: row.kind, widthPx: meta?.media?.widthPx, heightPx: meta?.media?.heightPx, mediaState: meta?.media?.state }, vp)
			this.corr.observe(k, row.kind, hPt, est.hPt)
			const prevRow = await this.backend!.getLayout(cb, stableId, k.wb, k.o, k.fb, k.lv)
			const prev = prevRow ? await this.openLayoutRow(prevRow) : null
			if (!measurementChanged(prev, wPt, hPt)) return { written: false }
			const out: LocalLayoutRow = {
				conv_blind: cb,
				stable_id: stableId,
				width_bucket: k.wb,
				orientation: k.o,
				font_bucket: k.fb,
				layout_version: k.lv,
				val_enc: await this.dek!.seal(await this.layoutAad(cb, stableId, k), utf8(JSON.stringify({ wPt, hPt }))),
				updated_ms: Date.now(),
			}
			await this.backend!.writeBatch([{ t: 'lput', row: out }])
			return { written: true }
		})
	}

	// ---- send path -------------------------------------------------------------

	/** Mark an outgoing row as unsent (pending_publish) so clearLocalCache keeps it. Same writer queue as sync. */
	async markPending(convKey: string, stableId: string, pending: boolean): Promise<boolean> {
		return this.serial(async () => {
			if (this.state !== 'open') return false
			const cb = await this.convBlindOf(convKey)
			const row = await this.backend!.getMsg(cb, stableId)
			if (!row) return false
			await this.backend!.writeBatch([{ t: 'put', row: { ...row, pending_publish: pending ? 1 : 0 } }])
			return true
		})
	}

	// ---- clear ----------------------------------------------------------

	/** Clears non-pending rows. Any scope increments dbEpoch so old cursors become invalid. */
	async clearLocalCache(scope: 'conversation' | 'account', convKey?: string): Promise<ClearResult> {
		return this.serial(async () => {
			if (this.state !== 'open') return { removed: 0, pendingKept: 0 }
			const backend = this.backend!
			const blinds = scope === 'conversation' && convKey ? [await this.convBlindOf(convKey)] : await backend.listConvBlinds()
			let removed = 0
			let pendingKept = 0
			const ops: LocalOp[] = []
			for (const cb of blinds) {
				for (const row of await backend.scanAsc(cb)) {
					if (row.pending_publish === 1) {
						pendingKept++
						continue
					}
					ops.push({ t: 'del', convBlind: cb, sortTs: row.sort_ts, stableId: row.stable_id }, { t: 'ldelFor', convBlind: cb, stableId: row.stable_id })
					removed++
				}
			}
			if (scope === 'account') await backend.putMeta('headIndexHash', '')
			await backend.writeBatch(ops)
			this.dbEpoch = newEpoch()
			await backend.putMeta('dbEpoch', this.dbEpoch)
			this.overlay.clear()
			this.generation++
			this.emit({ kind: 'cleared', scope, pendingKept })
			return { removed, pendingKept }
		})
	}

	// ---- sync state and migration ----------------------------------------

	/** `syncComplete` is set only after every index record was processed. */
	async setSyncComplete(done: boolean): Promise<void> {
		await this.serial(async () => {
			if (this.state !== 'open') return
			await this.backend!.putMeta('syncComplete', done ? '1' : '0')
			if (done) this.emit({ kind: 'olderAvailable' })
		})
	}

	async getMigrationState(): Promise<string> {
		if (this.state !== 'open') return 'none'
		return (await this.backend!.getMeta('migrationState')) ?? 'none'
	}

	/**
	 *  states: none, running, complete (with the sealed verified digest), switched,
	 * purged. Going back to running or none is only used on failure before.
	 */
	async setMigrationState(s: 'none' | 'running' | 'complete' | 'switched' | 'purged', verifiedDigest?: string): Promise<void> {
		await this.serial(async () => {
			if (this.state !== 'open') return
			if (s === 'complete' && verifiedDigest !== undefined) {
				const sealed = await this.dek!.seal(utf8('verifiedDigest'), utf8(verifiedDigest))
				await this.backend!.putMeta('verifiedDigest', base64url(sealed))
			}
			await this.backend!.putMeta('migrationState', s)
		})
	}

	/** The digest written at, unsealed. Null when none was written. */
	async readVerifiedDigest(): Promise<string | null> {
		if (this.state !== 'open') return null
		const v = await this.backend!.getMeta('verifiedDigest')
		if (!v) return null
		try {
			return textOf(await this.dek!.open(utf8('verifiedDigest'), fromBase64url(v)))
		} catch {
			this.stats.decryptFailures++
			return null
		}
	}

	/** HMAC-SHA256(K_idx, concatenated lines) in K order. Equal digests mean equal rows. */
	private async digestOf(lines: Uint8Array[]): Promise<string> {
		return base64url(await hmacSha256(this.idxKey!, concat(lines)))
	}

	/**
	 * Digest of live rows of one conversation. Each line is sendKey ‖ sort_ts ‖ dir ‖ body bytes, then LF.
	 */
	async digestConversation(convKey: string): Promise<{ count: number; digest: string }> {
		if (this.state !== 'open') return { count: 0, digest: '' }
		const cb = await this.convBlindOf(convKey)
		const rows = await this.backend!.scanAsc(cb)
		const parts: Uint8Array[] = []
		let count = 0
		for (const row of rows) {
			if (row.deleted === 1) continue
			const meta = await this.openMetaRow(row)
			const body = await this.openBodyRow(row)
			if (!meta || body === undefined) continue
			parts.push(joinFields(meta.sk, String(row.sort_ts), row.dir, body), utf8('\n'))
			count++
		}
		return { count, digest: await this.digestOf(parts) }
	}

	/** The same digest computed from source records (the expected side of ). */
	async expectedDigest(records: IncomingRecord[]): Promise<{ count: number; digest: string }> {
		const rows: Array<{ sortTs: number; stable: string; sk: string; dir: 'in' | 'out'; body: string }> = []
		const seenStable = new Set<string>()
		const seenContent = new Set<string>()
		for (const r of records) {
			if (r.deleted) continue
			const sk = await this.sendKeyOf(r)
			const stable = await this.stableIdOf(sk)
			const bh = await sha256Hex(utf8(r.body))
			const content = `${r.dir}|${r.sortTs}|${bh}`
			// the same sendKey, or the same content, is one message; the earliest in arrival order survives
			if (seenStable.has(stable) || seenContent.has(content)) continue
			seenStable.add(stable)
			seenContent.add(content)
			rows.push({ sortTs: r.sortTs, stable, sk, dir: r.dir, body: r.body })
		}
		rows.sort((a, b) => compareKey(a.sortTs, a.stable, b.sortTs, b.stable))
		const parts: Uint8Array[] = []
		for (const r of rows) parts.push(joinFields(r.sk, String(r.sortTs), r.dir, r.body), utf8('\n'))
		return { count: rows.length, digest: await this.digestOf(parts) }
	}

	/**
	 *  read-back: decrypt a random sample plus every pending row. Returns counts only; no content leaves.
	 */
	async verifyReadback(sample = 100): Promise<{ checked: number; failures: number }> {
		if (this.state !== 'open') return { checked: 0, failures: 1 }
		const all: LocalMsgRow[] = []
		for (const cb of await this.backend!.listConvBlinds()) all.push(...(await this.backend!.scanAsc(cb)))
		const live = all.filter((r) => r.deleted === 0)
		const picks = new Set<LocalMsgRow>(live.filter((r) => r.pending_publish === 1))
		for (let i = 0; i < Math.min(sample, live.length); i++) picks.add(live[Math.floor(Math.random() * live.length)])
		let failures = 0
		for (const row of picks) {
			const meta = await this.openMetaRow(row)
			const body = await this.openBodyRow(row)
			if (!meta || body === undefined) failures++
		}
		return { checked: picks.size, failures }
	}
}

/**
 * sendKey for a record that has no usable sendId, from the master key alone.
 * Used by the append path (D10) so the index carries the same sendKey the library derives.
 */
export async function deriveSendKey(kId: Uint8Array, rec: { convKey: string; dir: 'in' | 'out'; sortTs: number; body: string }): Promise<string> {
	return sendKeyFromRecord(kId, { ...rec, sendId: null })
}

/** True when a sendId can be used as the sendKey directly. */
export function isDirectSendKey(sendId: string | null | undefined): boolean {
	return !!sendId && !isUuid(sendId)
}
