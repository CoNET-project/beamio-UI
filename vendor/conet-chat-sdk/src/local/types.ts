/**
 * Public types for the local chat library (interface).
 * The same shapes are used by the iOS and Android SDKs.
 */

export type ChatKind = 'text' | 'image' | 'video' | 'file' | 'system' | 'unknown'
export type MediaState = 'pending' | 'ready' | 'failed'

/** UI viewport in points. The SDK never infers orientation. */
export interface Viewport {
	widthPt: number
	heightPt: number
	orientation: 'portrait' | 'landscape'
	fontScale: number
	layoutVersion: number
}

export interface MediaInfo {
	/** Ciphertext id from the index. Stored inside meta_enc only. */
	cid?: string
	mime: string
	widthPx?: number
	heightPx?: number
	state?: MediaState
}

/** Row as stored in `msg`. Plaintext columns hold keys, order and flags; never body text or sendId. */
export interface LocalMsgRow {
	conv_blind: string
	stable_id: string
	sort_ts: number
	dir: 'in' | 'out'
	kind: ChatKind
	revision: number
	deleted: 0 | 1
	pending_publish: 0 | 1
	cid_blind: string | null
	body_enc: Uint8Array | null
	meta_enc: Uint8Array | null
}

/** Row as stored in `layout`. Only the size pair is encrypted. */
export interface LocalLayoutRow {
	conv_blind: string
	stable_id: string
	width_bucket: number
	orientation: 'portrait' | 'landscape'
	font_bucket: number
	layout_version: number
	val_enc: Uint8Array
	updated_ms: number
}

/** Decrypted metadata (meta_enc). */
export interface LocalMeta {
	/** sendKey. Only inside the ciphertext. */
	sk: string
	/** Hash of the body, used for the sendKey conflict check. */
	bh: string
	media?: MediaInfo
}

export interface ChatItem {
	/** Library identifier. Used for reportLayout and UI de-duplication only. */
	stableId: string
	sortTs: number
	dir: 'in' | 'out'
	kind: ChatKind
	/** Text and system bodies only. */
	body?: string
	media?: { mime: string; widthPx?: number; heightPx?: number; state: MediaState }
	revision: number
	layout: { wPt: number; hPt: number; measured: boolean }
}

export type PageSource = 'local' | 'migrating' | 'locked'
export type OlderState = 'more' | 'pending' | 'end'

export interface PageResult {
	items: ChatItem[]
	/** Cursor for the next `loadOlder`. Null when `olderState` is `end`, or when nothing older is known yet. */
	olderCursor: string | null
	/** `more`: older raw rows exist. `pending`: sync not finished, so the end is unknown. `end`: sync finished and no older rows.  */
	olderState: OlderState
	/** The scan budget ran out before a visible item was found; the UI must ask again.  */
	scanExhausted: boolean
	syncState: 'idle' | 'running' | 'paused' | 'error'
	source: PageSource
	/** Local data ended before the viewport was filled (legal).  */
	short: boolean
	/** The safety cap stopped the fill. Not expected with normal viewports.  */
	capped: boolean
}

/** Seal and open for stored bodies, metadata and layout values. Only the encrypted implementation exists. */
export interface SealedStore {
	seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>
	open(aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>
}

/** Input to ingest: a decrypted record handed in by the sync or append path. */
export interface IncomingRecord {
	convKey: string
	dir: 'in' | 'out'
	sortTs: number
	/** Protocol sendId as carried in the index (after D10 this is already the sendKey for sendless messages). */
	sendId?: string | null
	/** Explicit sendKey when the caller already has it. Otherwise derived. */
	sendKey?: string
	kind: ChatKind
	/** Plaintext body; empty string for tombstones. Never logged. */
	body: string
	/** Ciphertext id from the index. Stored only as a blind index (cid_blind). */
	cid: string | null
	revision?: number
	deleted?: boolean
	media?: MediaInfo
	/** True when the message is a local unsent item that must not be dropped (pending_publish). */
	pending?: boolean
}

export type IngestOutcome = 'inserted' | 'updated' | 'recid' | 'deleted' | 'skipped' | 'conflict' | 'folded' | 'locked'

export interface SyncStats {
	records: number
	skipped: number
	fetched: number
	recid: number
	failed: number
	tsMismatch: number
	sendKeyConflict: number
	legacyUuidFetched: number
	folded: number
}

export interface ClearResult {
	removed: number
	pendingKept: number
}

/** Change events for open windows (–6.5). Only what the UI needs to react to. */
export type LocalEvent =
	| { kind: 'changed'; convKey: string; outcome: IngestOutcome; stableId: string; sortTs: number }
	| { kind: 'olderAvailable'; convKey?: string }
	| { kind: 'locked' }
	| { kind: 'cleared'; scope: 'conversation' | 'account'; pendingKept: number }
