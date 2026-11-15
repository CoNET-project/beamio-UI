/**
 * Plan N, (2 to.5): the shell's wallet record in the native store, over the
 * bridge. The page command set is fixed: shellRecordRead {type, reqId}; shellRecordWrite {type, reqId, record}. The record carries an
 * integer `rev` at its top level a read must give one (missing = error, fail closed); a write carries the rev it was made
 * on; a stale write answers `conflict` (currentRev) and is not written. Every answer other than `ok` or `absent` on a read is an
 * error. PGP private material is refused before anything is sent. The write carries schemaVersion 2; it never
 * carries the W-class fields (2: the native side keeps them) nor the PGP public fields. A read carries the W-class
 * fields and has the PGP fields stripped by the native side. walletFieldsRedacted is for older natives only.
 *
 * The write replaces the page record as a whole. The page therefore writes its copy of the record made on the revision it
 * read (the copy basis), with only its page-editable profile fields changed: the native-owned chat and profile fields
 * keep the stored values. A probe read (the page's pre-save read) never moves the copy basis, so the revision checked is the one the
 * copy was made on. After a write that got no answer, nothing is written until a read has answered.
 *
 * Deferred writes: a write the store does not take yet (migrating, a conflict, a timeout) is kept as an
 * intent: the page's change to its editable fields, as a delta. It is persisted without any W-class or PGP field. Once a read answers,
 * the change is applied to the record just read, at that record's revision. A field both sides changed keeps the page's edit when it
 * is page-editable; otherwise the store's value. The intent survives a restart and is retried with a backoff that never gives up.
 */
import { nextReqId } from './nativeChatRouteRegister'
import { sendShellRecordCommand, type ShellRecordAnswer } from './shellRecordTransport'
import { setDeferredLocalOnly } from './pendingServerSync'
import { publishNativePwaLog } from '../utils/cashTreesNativePwaLog'
import { assertNoPgpPrivate, BRIDGE_LIMIT_BYTES, canonicalizeProfileKeyIDs, pgpPublicPaths, sanitizeForBridge, shellWalletState, stripWalletFields, utf8ByteLength } from './shellRecordSanitizer'
import { backoffDelayMs } from './retryBackoff'
import { notifyAppUpdateRequired } from './appUpdatePrompt'

export const SHELL_RECORD_READ = 'shellRecordRead'
export const SHELL_RECORD_WRITE = 'shellRecordWrite'
/**5: the record schema that carries the W-class copy. Older pages (below 2) are the legacy compatibility path. */
export const RECORD_SCHEMA_VERSION = 2
/**4: a request times out after 10 seconds. */
const TIMEOUT_MS = 10_000
/** The persisted deferred write (the page's editable delta and the revision; no W-class field, no PGP private field). */
export const DEFERRED_WRITE_KEY = 'beamio.shell.deferredWrite.v1'

type Loose = Record<string, unknown>

export type ShellRecordRead =
	| { status: 'absent' }
	| { status: 'ok'; record: Loose; rev: number; walletFieldsRedacted: boolean }
	| { status: 'error'; reason: string }

export type ShellRecordWrite = { status: 'ok'; rev: number } | { status: 'conflict'; currentRev: number | null } | { status: 'error'; reason: string }

/**
 * The copy basis: the revision and the sanitized record the page's copy was built from. It is set by a read that feeds
 * the copy (a read that is not a probe) and by a write the store accepted. A probe read never moves it.
 */
let basisRev: number | null = null
let basisRecord: Loose | null = null
/** True after a write got no answer: nothing is written until a read has answered ok or absent. */
let blocked = false
/**
 * the page-editable fields the page's own deferred write put into the store without moving the basis. A later revert of such a field
 * is a real change and is written (it is not "no change against the basis"). Cleared when the basis moves.
 */
const ownEdits = new Map<string, { vh: boolean; v?: unknown }>()
/** b /.4: chats the store has accepted as removed by the page (the basis still has them). Cleared when the basis moves. */
const ownRemovals = new Set<string>()

export function buildShellRecordReadCommand(reqId: number): { type: string; reqId: number } {
	return { type: SHELL_RECORD_READ, reqId }
}

/**
 * The write command for a record at the given revision. Refuses PGP private material first. The W-class fields are never sent
 * (2 rule 1: an omitted W field is kept by the native side); the PGP public fields are not accepted by the write whitelist
 * so a copy that has them is refused. The size limit is in UTF-8 bytes.
 */
export function buildShellRecordWriteCommand(reqId: number, record: Loose, rev: number): { type: string; reqId: number; record: Loose } {
	assertNoPgpPrivate(record)
	// a copy with PGP public fields is refused with the path names; it is not stripped and sent.
	const pgpPublic = pgpPublicPaths(record)
	if (pgpPublic.length) throw new Error(`pgp_field_not_allowed: ${pgpPublic.join(', ')}`)
	const sanitized = stripWalletFields(sanitizeForBridge({ ...record, rev, schemaVersion: RECORD_SCHEMA_VERSION })) as Loose
	if (utf8ByteLength(JSON.stringify(sanitized)) > BRIDGE_LIMIT_BYTES) throw new Error('too_large')
	return { type: SHELL_RECORD_WRITE, reqId, record: sanitized }
}

/** Reads the answer of a read. Only `ok` with an integer rev, or `absent`, is accepted; anything else is an error. */
export function parseShellRecordRead(payload: Loose | null): ShellRecordRead {
	//2: the ack envelope. ok:false is an envelope-level failure (error = the code). ok:true carries the answer in
	// result.code: ok (with record), absent, error (with sub), migrating. Anything else, or an unknown code, fails closed.
	if (!payload || payload.type !== 'ack') return { status: 'error', reason: 'native_unavailable' }
	if (payload.ok !== true) return { status: 'error', reason: typeof payload.error === 'string' ? payload.error : 'native_unavailable' }
	const result = payload.result
	if (!result || typeof result !== 'object') return { status: 'error', reason: 'bad_answer' }
	const r = result as Loose
	if (r.code === 'absent') return { status: 'absent' }
	if (r.code === 'error') return { status: 'error', reason: typeof r.sub === 'string' ? r.sub : 'error' }
	if (r.code === 'ok') {
		const record = r.record
		if (!record || typeof record !== 'object' || Array.isArray(record)) return { status: 'error', reason: 'bad_answer' }
		const rev = (record as Loose).rev
		if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return { status: 'error', reason: 'rev_missing' }
		try {
			assertNoPgpPrivate(record)
		} catch {
			return { status: 'error', reason: 'pgp_private_in_payload' }
		}
		// a normal read always carries the W-class fields. A record without them is an error, never absent.
		// the record state; a non-ok state is an error (a hold), never absent.
		const state = shellWalletState(record)
		if (state !== 'ok') return { status: 'error', reason: state }
		// walletFieldsRedacted is set only by an older native side; the current side does not send it.
		return { status: 'ok', record: canonicalizeProfileKeyIDs(record as Loose), rev, walletFieldsRedacted: r.walletFieldsRedacted === true }
	}
	return { status: 'error', reason: typeof r.code === 'string' ? r.code : 'bad_answer' }
}

/** Reads the answer of a write `ok` with the new rev, or `conflict` with currentRev, or an error code. */
export function parseShellRecordWrite(payload: Loose | null): ShellRecordWrite {
	if (!payload || payload.type !== 'ack' || payload.ok !== true) return { status: 'error', reason: 'native_unavailable' }
	const result = payload.result
	if (!result || typeof result !== 'object') return { status: 'error', reason: 'bad_answer' }
	const r = result as Loose
	if (r.code === 'ok' && typeof r.rev === 'number' && Number.isInteger(r.rev)) return { status: 'ok', rev: r.rev }
	if (r.code === 'conflict') return { status: 'conflict', currentRev: typeof r.currentRev === 'number' ? r.currentRev : null }
	return { status: 'error', reason: typeof r.code === 'string' ? r.code : 'bad_answer' }
}

/**
 * The shell read as the wallet record. `absent`is the only answer that gives null (a confirmed empty
 * store). A record without the W-class fields is an error, never an absent wallet. A redacted read (older native only) and any other
 * answer throw. Errors carry the `shell_record_` prefix that the storage read maps to `unavailable`.
 */
export function shellRecordAsWalletRecord(r: ShellRecordRead): Loose | null {
	if (r.status === 'absent') return null
	if (r.status !== 'ok') throw new Error(`shell_record_${r.reason}`)
	if (r.walletFieldsRedacted) throw new Error('shell_record_wallet_fields_redacted')
	// the record state; only ok is entered. needs_native_recovery and wallet_fields_missing are holds, never onboarding.
	const state = shellWalletState(r.record)
	if (state !== 'ok') throw new Error(`shell_record_${state}`)
	return r.record
}

// ---------------------------------------------------------------------------------------------------------------------------
// Deltas

/**
 * the page-editable profile fields. When the store and the page both changed one of them during a deferral, the page's edit
 * is the later user intent and is kept. The shell writes only these fields from the page.
 * accountName is not here: it is the registered BeamioTag (the account page locks it on entry; the registry looks the account up by it).
 */
export const PAGE_EDITABLE_BEAMIO_FIELDS: readonly string[] = [
	'image',
	'firstName',
	'lastName',
	'darkTheme',
	'isUSDCFaucet',
	'isETHFaucet',
	'language',
	'currency',
	'tax',
	'localeCurrencyConfigured',
]
const EDITABLE_FIELDS = new Set<string>(PAGE_EDITABLE_BEAMIO_FIELDS)
const isPageEditable = (path: string[]): boolean => path.length === 2 && path[0] === 'beamio' && EDITABLE_FIELDS.has(path[1])

/**
 * The page's change as field-level operations against a record. A leaf field is `set` (with its base value). A keyed item (a profile,
 * a chat) is `add` or `rm`; a change inside it is a path into it (`#id`). A plain list (messages) is `addU` or `rmU`.
 */
export type DeltaOp =
	| { k: 'set'; p: string[]; bh: boolean; b?: unknown; vh: boolean; v?: unknown }
	| { k: 'add'; p: string[]; id: string; v: unknown }
	| { k: 'rm'; p: string[]; id: string }
	| { k: 'addU'; p: string[]; v: unknown }
	| { k: 'rmU'; p: string[]; c: string }

/** A write the store did not take: the page's editable delta, the full copy (memory only, for a first write) and the attempts. */
type DeferredWrite = { ours: Loose | null; ops: DeltaOp[]; rev: number | null; attempts: number; refused?: string }

const DELTA_VERSION = 1

let deferred: DeferredWrite | null = null
let deferredTimer: ReturnType<typeof setTimeout> | null = null
let retrying = false
const WRITE_RETRY_MS = 3000
/**
 * (-confirmed by the interface owner): a write refused for these codes is a failure. It is not success, the intent
 * is not retried (no silent field drop and no automatic retry), and no other channel is used. Only the code is recorded.
 */
const WRITE_REFUSAL_CODES: ReadonlySet<string> = new Set(['key_shaped_content', 'wallet_copy_not_approved'])

const isPlain = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v)

function storageOrNull(): Storage | null {
	try {
		return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
	} catch {
		return null
	}
}

/** A copy for the page's memory: no W-class field and no PGP private material. */
function sanitizedCopy(record: Loose): Loose {
	const copy = stripWalletFields(sanitizeForBridge(record)) as Loose
	assertNoPgpPrivate(copy)
	return copy
}

/** The record with its profile-copy object present (a store record may not have one yet). */
function withBeamio(record: Loose): Loose {
	return { ...record, beamio: isPlain(record.beamio) ? { ...record.beamio } : {} }
}

/** A key-sorted JSON form, so equal values compare equal whatever the key order; undefined stays undefined. */
function canon(v: unknown): string | undefined {
	const sorted = (x: unknown): unknown => {
		if (Array.isArray(x)) return x.map(sorted)
		if (x !== null && typeof x === 'object') {
			const o = x as Loose
			const out: Loose = {}
			for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sorted(o[k])
			return out
		}
		return x
	}
	return JSON.stringify(sorted(v))
}

const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b)

/** The identity of an item of a list of profiles or chats: its keyID or address (lower case). */
function identityOf(v: unknown): string | undefined {
	if (!isPlain(v)) return undefined
	const id = typeof v.keyID === 'string' ? v.keyID : typeof v.address === 'string' ? v.address : undefined
	return id ? id.toLowerCase() : undefined
}

/** The delta from `base` to `ours`. The revision and schema fields are not part of the change. */
function diffRecord(base: Loose, ours: Loose): DeltaOp[] {
	const strip = (r: Loose): Loose => {
		const c: Loose = { ...r }
		delete c.rev
		delete c.schemaVersion
		return c
	}
	const out: DeltaOp[] = []
	diffInto(strip(base), strip(ours), [], out)
	return out
}

function diffInto(base: unknown, ours: unknown, path: string[], out: DeltaOp[]): void {
	if (same(base, ours)) return
	if (isPlain(base) && isPlain(ours)) {
		for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) diffInto(base[k], ours[k], [...path, k], out)
		return
	}
	if (Array.isArray(ours) && (Array.isArray(base) || base === undefined)) {
		const b: unknown[] = Array.isArray(base) ? base : []
		if ([...b, ...ours].every((e) => identityOf(e) !== undefined)) {
			const bm = new Map(b.map((e) => [identityOf(e) as string, e] as const))
			const om = new Map(ours.map((e) => [identityOf(e) as string, e] as const))
			for (const [id, e] of om) if (!bm.has(id)) out.push({ k: 'add', p: path, id, v: e })
			for (const id of bm.keys()) if (!om.has(id)) out.push({ k: 'rm', p: path, id })
			for (const [id, oe] of om) if (bm.has(id)) diffInto(bm.get(id), oe, [...path, `#${id}`], out)
			return
		}
		const bc = new Set(b.map((e) => canon(e)))
		const oc = new Set(ours.map((e) => canon(e)))
		for (const e of ours) if (!bc.has(canon(e))) out.push({ k: 'addU', p: path, v: e })
		for (const e of b) if (!oc.has(canon(e))) out.push({ k: 'rmU', p: path, c: canon(e) ?? '' })
		return
	}
	out.push({ k: 'set', p: path, bh: base !== undefined, b: base, vh: ours !== undefined, v: ours })
}

/** The container at a path in `root` (a `#id` segment names a keyed item of a list). undefined when the store no longer has it. */
function resolveAt(root: unknown, path: string[]): unknown {
	let cur: unknown = root
	for (const seg of path) {
		if (seg.startsWith('#')) {
			if (!Array.isArray(cur)) return undefined
			const id = seg.slice(1)
			cur = cur.find((e) => identityOf(e) === id)
		} else {
			if (!isPlain(cur)) return undefined
			cur = cur[seg]
		}
		if (cur === undefined) return undefined
	}
	return cur
}

const copyOf = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export type MergeConflict = { field: string; kept: 'page' | 'store' }

/**
 * Applies a page delta to a record. A field the store did not change takes the page's value. A field both changed keeps
 * the page's value only when it is page-editable; otherwise the store's value stays. Every conflict is returned with its field path and
 * the side kept (names only, never values). Pure: `fresh` and `ops` are not changed.
 */
export function applyDelta(fresh: Loose, ops: DeltaOp[]): { record: Loose; conflicts: MergeConflict[] } {
	const out = copyOf(fresh)
	const conflicts: MergeConflict[] = []
	for (const op of ops) {
		const field = op.p.join('.')
		if (op.k === 'set') {
			const parent = resolveAt(out, op.p.slice(0, -1))
			if (!isPlain(parent)) continue
			const key = op.p[op.p.length - 1]
			const has = Object.prototype.hasOwnProperty.call(parent, key)
			const cur = parent[key]
			const storeChanged = !(has === op.bh && same(cur, op.b))
			if (storeChanged && !isPageEditable(op.p)) {
				if (!(has === op.vh && same(cur, op.v))) conflicts.push({ field, kept: 'store' })
				continue
			}
			if (storeChanged && !(has === op.vh && same(cur, op.v))) conflicts.push({ field, kept: 'page' })
			if (op.vh) parent[key] = copyOf(op.v)
			else delete parent[key]
			continue
		}
		const arr = resolveAt(out, op.p)
		if (!Array.isArray(arr)) continue
		if (op.k === 'add') {
			const existing = arr.find((e) => identityOf(e) === op.id)
			if (existing === undefined) arr.push(copyOf(op.v))
			else if (!same(existing, op.v)) conflicts.push({ field: `${field}.#${op.id}`, kept: 'store' })
		} else if (op.k === 'rm') {
			const idx = arr.findIndex((e) => identityOf(e) === op.id)
			if (idx >= 0) arr.splice(idx, 1)
		} else if (op.k === 'addU') {
			if (!arr.some((e) => canon(e) === canon(op.v))) arr.push(copyOf(op.v))
		} else {
			for (let i = arr.length - 1; i >= 0; i--) if (canon(arr[i]) === op.c) arr.splice(i, 1)
		}
	}
	return { record: out, conflicts }
}

/** The chats of a profile (`profiles[#id].chats`): a page removal of a chat names this path. Messages are native-owned and are not removed by the page. */
const isChatsPath = (p: string[]): boolean => p.length === 3 && p[0] === 'profiles' && p[1].startsWith('#') && p[2] === 'chats'

/**
 * The page's own delta against a base record: the page-editable fields, and a chat the user removed. Other changes (chats
 * added, messages, native-owned fields) are not written. The rest is logged by path.
 */
function editableOps(base: Loose, ours: Loose): DeltaOp[] {
	const all = diffRecord(withBeamio(base), withBeamio(ours))
	const kept = all.filter((op) => isPageEditable(op.p) || (op.k === 'rm' && isChatsPath(op.p)))
	const dropped = [...new Set(all.filter((op) => !isPageEditable(op.p)).map((op) => op.p.join('.')))]
	if (dropped.length) publishNativePwaLog('info', `[shellRecord] page changes not written (not page-editable; the native record keeps them): ${dropped.join(', ')}`)
	return kept
}

/** The delta between two records, as the page's change. Exported for the tests of the rule. */
export function changesOf(base: Loose | null, ours: Loose): DeltaOp[] {
	return diffRecord(base ?? {}, ours)
}

/** The conflicts are logged by field path and the side kept, never by value. */
function logConflicts(conflicts: MergeConflict[]): void {
	if (conflicts.length === 0) return
	const names = conflicts.map((c) => `${c.field}(${c.kept})`).join(', ')
	publishNativePwaLog('info', `[shellRecord] deferred write merged; fields changed on both sides (kept: page|store): ${names}`)
}

// ---------------------------------------------------------------------------------------------------------------------------
// The persisted intent

function persistDeferred(): void {
	const s = storageOrNull()
	let heldInMemoryOnly = false
	if (deferred !== null) {
		if (s) {
			try {
				s.setItem(DEFERRED_WRITE_KEY, JSON.stringify({ v: DELTA_VERSION, rev: deferred.rev, ops: deferred.ops, attempts: deferred.attempts, refused: deferred.refused ?? null }))
			} catch {
				// Quota: the intent is kept in memory only, and the page shows the pending notice. A stale stored copy is removed.
				heldInMemoryOnly = true
				try {
					s.removeItem(DEFERRED_WRITE_KEY)
				} catch {
					/* nothing more to do */
				}
			}
		} else {
			heldInMemoryOnly = true
		}
	} else if (s) {
		try {
			s.removeItem(DEFERRED_WRITE_KEY)
		} catch {
			/* nothing to remove */
		}
	}
	setDeferredLocalOnly(heldInMemoryOnly)
}

function loadDeferred(): DeferredWrite | null {
	const s = storageOrNull()
	if (!s) return null
	try {
		const raw = s.getItem(DEFERRED_WRITE_KEY)
		if (!raw) return null
		const o = JSON.parse(raw) as { v?: unknown; rev?: unknown; ops?: unknown; attempts?: unknown; refused?: unknown }
		if (o.v !== DELTA_VERSION || !Array.isArray(o.ops)) return null
		return {
			ours: null,
			ops: o.ops as DeltaOp[],
			rev: typeof o.rev === 'number' ? o.rev : null,
			attempts: typeof o.attempts === 'number' ? o.attempts : 0,
			...(typeof o.refused === 'string' && WRITE_REFUSAL_CODES.has(o.refused) ? { refused: o.refused } : {}),
		}
	} catch {
		return null
	}
}

function opKey(op: DeltaOp): string {
	if (op.k === 'set') return `set:${op.p.join('.')}`
	if (op.k === 'add' || op.k === 'rm') return `${op.k}:${op.p.join('.')}:${op.id}`
	if (op.k === 'addU') return `addU:${op.p.join('.')}:${canon(op.v)}`
	return `rmU:${op.p.join('.')}:${op.c}`
}

/** Two intents of the same basis: each path or item keeps the latest change (the later page copy already contains the earlier ones). */
function mergeIntentOps(a: DeltaOp[], b: DeltaOp[]): DeltaOp[] {
	const out: DeltaOp[] = []
	for (const op of [...a, ...b]) {
		const k = opKey(op)
		const i = out.findIndex((x) => opKey(x) === k)
		if (i >= 0) out[i] = op
		else out.push(op)
	}
	return out
}

/** Keeps the page's change as the intent, merged with the intent it follows. */
function deferWrite(ops: DeltaOp[], ours: Loose | null): void {
	// A refused intent stays refused when more changes are merged into it: only a successful write clears the refusal.
	deferred = {
		ours: ours ?? deferred?.ours ?? null,
		ops: mergeIntentOps(deferred?.ops ?? [], ops),
		rev: basisRev,
		attempts: deferred?.attempts ?? 0,
		...(deferred?.refused !== undefined ? { refused: deferred.refused } : {}),
	}
	persistDeferred()
	scheduleDeferredRetry()
}

function clearDeferred(pending: DeferredWrite): void {
	if (deferred !== pending) return
	deferred = null
	persistDeferred()
}

function scheduleDeferredRetry(): void {
	if (deferredTimer !== null || retrying || deferred === null) return
	//a refused intent is not retried automatically (on a timer, after a restart or after a read).
	if (deferred.refused !== undefined) return
	const delay = backoffDelayMs(WRITE_RETRY_MS, deferred.attempts)
	deferredTimer = setTimeout(() => {
		deferredTimer = null
		void retryDeferredWrite()
	}, delay)
}

function countAttempt(pending: DeferredWrite): void {
	if (deferred !== pending) return
	deferred = { ...pending, attempts: pending.attempts + 1 }
	persistDeferred()
}

/**
 * Resumes a deferred write that was persisted before a restart. The app calls it when the native wallet is ready at start, when the
 * storage is not read at all; a read that answers also resumes it.
 */
export function resumeDeferredWrite(): void {
	if (deferred === null) deferred = loadDeferred()
	scheduleDeferredRetry()
}

async function retryDeferredWrite(): Promise<void> {
	const pending = deferred ?? loadDeferred()
	if (!pending) return
	deferred = pending
	retrying = true
	try {
		// A probe read: it completes a read and the answer is merged here; it does not move the copy basis. Raw: the intent is applied here.
		const read = await shellRecordRead({ probe: true, raw: true })
		if (read.status !== 'ok' && read.status !== 'absent') {
			countAttempt(pending)
			return
		}
		let payload: Loose
		let rev: number
		if (read.status === 'ok') {
			if (pending.ops.length === 0) {
				clearDeferred(pending)
				return
			}
			// the change is applied to the record just read, at that record's revision. The page's old copy is never written back.
			const applied = applyDelta(withBeamio(sanitizedCopy(read.record)), pending.ops)
			logConflicts(applied.conflicts)
			payload = applied.record
			rev = read.rev
		} else {
			// The store is absent: only a first write of the page's full copy can create the record; a change alone never does.
			if (!pending.ours) {
				countAttempt(pending)
				return
			}
			payload = pending.ours
			rev = 0
		}
		const out = await writeAt(payload, rev)
		if (out.status === 'ok') {
			// the copy basis does not move here. The page copy still derives from the basis it was made on; moving it to the
			// merged record would make the next save treat the stale copy's values as page changes and overwrite the imported ones.
			noteApplied(pending.ops)
			clearDeferred(pending)
			return
		}
		if (out.status === 'failed' && WRITE_REFUSAL_CODES.has(out.reason)) {
			//the store refused the write. A failure, never a success; the intent is kept with the code and not retried.
			if (deferred === pending) {
				deferred = { ...pending, attempts: pending.attempts + 1, refused: out.reason }
				persistDeferred()
			}
			publishNativePwaLog('info', `[shellRecord] write refused by the store (${out.reason}); not retried`)
			return
		}
		countAttempt(pending)
	} catch {
		countAttempt(pending)
	} finally {
		retrying = false
		scheduleDeferredRetry()
	}
}

// ---------------------------------------------------------------------------------------------------------------------------

/** A transport outcome that is not a payload, as the reason of an error (no fallback, the reason is the answer). */
function transportReason(answer: ShellRecordAnswer): string {
	switch (answer.kind) {
		case 'timeout':
			return 'timeout'
		case 'origin_refused':
			return 'origin_refused'
		case 'not_supported':
			return 'not_supported'
		case 'none':
			return 'no_channel'
		case 'payload':
			return 'bad_answer'
		default:
			return 'native_unavailable'
	}
}

/** The answer of one write, as the page acts on it. */
type WriteOutcome = { status: 'ok'; rev: number } | { status: 'conflict' } | { status: 'migrating' } | { status: 'timeout' } | { status: 'failed'; reason: string }

/** One write at a revision. A timeout blocks further writes until a read has answered. */
async function writeAt(payload: Loose, rev: number): Promise<WriteOutcome> {
	const reqId = nextReqId()
	const command = buildShellRecordWriteCommand(reqId, payload, rev)
	const answer = await sendShellRecordCommand(command, TIMEOUT_MS)
	if (answer.kind === 'timeout') {
		blocked = true
		return { status: 'timeout' }
	}
	// the native layer refused this build: the update prompt is shown (the same prompt a refused read shows).
	if (answer.kind === 'origin_refused') notifyAppUpdateRequired()
	if (answer.kind !== 'payload') return { status: 'failed', reason: transportReason(answer) }
	const parsed = parseShellRecordWrite(answer.payload)
	if (parsed.status === 'ok') return { status: 'ok', rev: parsed.rev }
	if (parsed.status === 'conflict') return { status: 'conflict' }
	if (parsed.reason === 'migrating') return { status: 'migrating' }
	return { status: 'failed', reason: parsed.reason }
}

/** Reads the sanitized record from the native store. Never throws: a missing bridge or a bad answer is an error. */
/**
 * A read of the record. The record returned is the page's view: the stored record with the page's held change applied (H1, and for
 * a probe too), so a copy that a probe feeds keeps the change. A probe does not move the copy basis. `raw` returns the stored record
 * as it is, for a write that applies its own intent (the retry and the removals).
 */
export async function shellRecordRead(options: { probe?: boolean; raw?: boolean } = {}): Promise<ShellRecordRead> {
	const reqId = nextReqId()
	const answer = await sendShellRecordCommand(buildShellRecordReadCommand(reqId), TIMEOUT_MS)
	if (answer.kind !== 'payload') return { status: 'error', reason: transportReason(answer) }
	const parsed = parseShellRecordRead(answer.payload)
	if (parsed.status === 'ok' || parsed.status === 'absent') {
		// A read that answered ok or absent completes the read: a write may follow.
		blocked = false
		if (!options.probe) {
			basisRev = parsed.status === 'ok' ? parsed.rev : 0
			basisRecord = parsed.status === 'ok' ? sanitizedCopy(parsed.record) : null
			ownEdits.clear()
			ownRemovals.clear()
		}
		if (deferred === null) deferred = loadDeferred()
		scheduleDeferredRetry()
		// H1 : the copy a read feeds includes the page's pending change, so a plain save keeps it. A restart rebuilds the copy from
		// the store; without this the copy equals the basis and the save would clear the intent. The basis stays the store's record.
		// (Chat SDK): the same holds for a probe that puts the record in the copy (persistAndVerify).
		if (!options.raw && parsed.status === 'ok' && deferred !== null && deferred.ops.length > 0) {
			return { ...parsed, record: applyDelta(parsed.record, deferred.ops).record }
		}
	}
	return parsed
}

/** The value of a path in a record, and whether the record has it. */
function valueAt(root: Loose, p: string[]): { has: boolean; v: unknown } {
	const parent = resolveAt(root, p.slice(0, -1))
	if (!isPlain(parent)) return { has: false, v: undefined }
	const key = p[p.length - 1]
	return { has: Object.prototype.hasOwnProperty.call(parent, key), v: parent[key] }
}

/** After a write the store accepted from the page's intent: the editable fields it now holds from the page, and the removed chats. */
function noteApplied(ops: DeltaOp[]): void {
	const base = withBeamio(basisRecord ?? {})
	for (const op of ops) {
		if (op.k === 'set' && isPageEditable(op.p)) {
			const key = op.p.join('.')
			const b = valueAt(base, op.p)
			if (op.vh === b.has && same(op.v, b.v)) ownEdits.delete(key) // the store holds the basis value again
			else ownEdits.set(key, { vh: op.vh, v: op.v })
		} else if (op.k === 'rm' && isChatsPath(op.p)) {
			ownRemovals.add(op.id)
		}
	}
}

/**
 * a held change (in the intent, not yet merged into the store) that the page now reverts to the basis value is stale:
 * the store still holds the basis value, so the change is dropped from the intent. Merged changes are reverted through revertOps.
 */
function dropRevertedHeld(ours: Loose, others: DeltaOp[]): void {
	if (deferred === null) return
	const base = withBeamio(basisRecord ?? {})
	const copy = withBeamio(ours)
	const stale = new Set<string>()
	for (const op of deferred.ops) {
		if (op.k !== 'set' || !isPageEditable(op.p)) continue
		const key = op.p.join('.')
		if (ownEdits.has(key) || others.some((o) => o.k === 'set' && o.p.join('.') === key)) continue
		const cur = valueAt(copy, op.p)
		const b = valueAt(base, op.p)
		if (cur.has === b.has && same(cur.v, b.v)) stale.add(key)
	}
	if (stale.size === 0) return
	deferred = { ...deferred, ops: deferred.ops.filter((op) => !(op.k === 'set' && isPageEditable(op.p) && stale.has(op.p.join('.')))) }
	persistDeferred()
}

/**
 * a field the page's own deferred write put into the store, that the page now reverts to the basis value, is written back as a real
 * change. Without it the revert would look like "no change against the basis" and the store would keep the merged value.
 */
function revertOps(ours: Loose, others: DeltaOp[]): DeltaOp[] {
	const out: DeltaOp[] = []
	const base = withBeamio(basisRecord ?? {})
	const copy = withBeamio(ours)
	for (const [key, own] of ownEdits) {
		if (others.some((op) => op.k === 'set' && op.p.join('.') === key)) continue
		const p = key.split('.')
		const cur = valueAt(copy, p)
		const b = valueAt(base, p)
		if (cur.has !== b.has || !same(cur.v, b.v)) continue // the page still differs from the basis there: it is an edit, not a revert
		if (own.vh === b.has && same(own.v, b.v)) continue // the store already holds the basis value
		out.push({ k: 'set', p, bh: own.vh, b: own.v, vh: b.has, v: b.v })
	}
	return out
}

/**
 * b /.4: a removed chat is written from a freshly read record, at that record's revision, with only that chat removed.
 * Returns false when the store does not take it now: the removal is kept as an intent and the retry reads again.
 */
async function applyRemovalsNow(removals: DeltaOp[]): Promise<boolean> {
	const read = await shellRecordRead({ probe: true, raw: true })
	if (read.status === 'absent') return true
	if (read.status === 'ok') {
		const payload = applyDelta(withBeamio(sanitizedCopy(read.record)), removals).record
		const out = await writeAt(payload, read.rev)
		if (out.status === 'ok') {
			noteApplied(removals)
			return true
		}
		if (out.status === 'failed') throw new Error(out.reason)
	}
	deferWrite(removals, null)
	return false
}

/**
 * Writes the page's copy of the record. Only the page-editable profile fields are written, and a chat the user removed
 * The editable fields are written on the copy basis'revision (the basis record with the changes; a revert included); a removal
 * is written from a freshly read record. A write the store does not take (migrating, a conflict, a timeout) is kept as an
 * intent and resolves; it is sent later on the record just read. Throws `not_read` before a read that feeds the copy, and the error code
 * for a refusal that is not a deferral.
 */
export async function shellRecordWrite(record: Loose): Promise<void> {
	if (basisRev === null) throw new Error('not_read')
	const ours = sanitizedCopy(record)
	// Nothing is written before a read has answered after a timeout: the change is kept, and the retry reads first.
	if (blocked) {
		//a revert made while blocked is recorded too (it is not "no change" against the basis when the store holds a merged value).
		const all = editableOps(basisRecord ?? {}, ours)
		dropRevertedHeld(ours, all)
		deferWrite([...all, ...revertOps(ours, all)], basisRev === 0 ? ours : null)
		return
	}
	if (basisRev === 0) {
		// The first write of a record (the store is absent): the page's full copy creates it.
		const out = await writeAt(ours, 0)
		if (out.status === 'ok') {
			basisRev = out.rev
			basisRecord = ours
			ownEdits.clear()
			ownRemovals.clear()
			deferred = null
			persistDeferred()
			return
		}
		if (out.status === 'failed') throw new Error(out.reason)
		deferWrite([], ours)
		return
	}
	const all = editableOps(basisRecord ?? {}, ours)
	const removals = all.filter((op) => op.k === 'rm' && isChatsPath(op.p) && !(op.k === 'rm' && ownRemovals.has(op.id)))
	const others = all.filter((op) => !(op.k === 'rm' && isChatsPath(op.p)))
	dropRevertedHeld(ours, others)
	let removalsPending = false
	if (removals.length > 0) removalsPending = !(await applyRemovalsNow(removals))
	const writeOps = [...others, ...revertOps(ours, others)]
	if (writeOps.length === 0) {
		if (deferred !== null) {
			// The copy equals the basis in the fields the page owns: an older intent the user reverted is not replayed. A removal still
			// waiting for the store stays.
			deferred = removalsPending ? { ...deferred, ops: deferred.ops.filter((op) => !(op.k === 'set' && isPageEditable(op.p))) } : null
			persistDeferred()
		}
		return
	}
	if (removalsPending) {
		// The removal is waiting for the store: the editable changes wait with it, to be applied to the record just read.
		deferWrite(writeOps, null)
		return
	}
	const payload = applyDelta(withBeamio(basisRecord ?? {}), writeOps).record
	const out = await writeAt(payload, basisRev as number)
	if (out.status === 'ok') {
		basisRev = out.rev
		basisRecord = sanitizedCopy(payload)
		// A write the store accepted holds the page's complete editable state: the basis moves, and older intents are superseded.
		ownEdits.clear()
		ownRemovals.clear()
		deferred = null
		persistDeferred()
		return
	}
	if (out.status === 'failed') throw new Error(out.reason)
	deferWrite(writeOps, null)
}

/** Test-only: the page's copy revision (the basis of the next write). */
export function knownRevForTest(): number | null {
	return basisRev
}

/** Test-only: the deferred intent in memory (or null). */
export function deferredWriteForTest(): DeferredWrite | null {
	return deferred
}

/** Test-only reset. `keepStorage` keeps the persisted intent, to simulate a restart (the memory is cleared). */
export function resetShellRecordForTest(keepStorage = false): void {
	basisRev = null
	basisRecord = null
	blocked = false
	ownEdits.clear()
	ownRemovals.clear()
	retrying = false
	if (deferredTimer !== null) clearTimeout(deferredTimer)
	deferredTimer = null
	deferred = null
	if (!keepStorage) storageOrNull()?.removeItem(DEFERRED_WRITE_KEY)
}
