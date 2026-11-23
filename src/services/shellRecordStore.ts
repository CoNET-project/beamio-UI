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
import { diagnosticCode } from './diagnosticCodes'
import { NOT_READY_BOUNDED_DELAYS_MS, notReadyClass } from './shellStoreWait'
import { nextReqId } from './nativeChatRouteRegister'
import { sendShellRecordCommand, type ShellRecordAnswer } from './shellRecordTransport'
import { setDeferredLocalOnly } from './pendingServerSync'
import { publishNativePwaLog } from '../utils/cashTreesNativePwaLog'
import { assertNoPgpPrivate, BRIDGE_LIMIT_BYTES, canonicalizeProfileKeyIDs, pgpPublicPaths, sanitizeForBridge, shellWalletState, stripWalletFields, utf8ByteLength } from './shellRecordSanitizer'
import { backoffDelayMs } from './retryBackoff'
import { isMnemonicPhrase } from './walletCredential'
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
	| { status: 'ok'; record: Loose; rev: number; walletFieldsRedacted: boolean; copyValidated?: boolean; eoa?: string | null }
	| { status: 'error'; reason: string; notReady?: { retryable: unknown; notReadyReason?: string; unreadableCause?: string; persistent: boolean }; keylessRecord?: Loose }

export type ShellRecordWrite = { status: 'ok'; rev: number } | { status: 'conflict'; currentRev: number | null } | { status: 'error'; reason: string; notReady?: { retryable: unknown; notReadyReason?: string; persistent: boolean } }

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
/**
 * The classification fields of a read answer for the diagnostic line (2026-11-21; v162 §182): the envelope field names, the
 * result code, notReadyReason, retryable and unreadableCause, as categories only. A value that is not a short lower-case code is logged as `other`; no record, key or
 * free text is ever logged. Returns a leading-space string, or '' when the answer carries none of them.
 */
export function shellReadDiagnosticFields(payload: Loose | null): string {
	const r = (payload && typeof payload === 'object' && payload.result && typeof payload.result === 'object' ? payload.result : null) as Loose | null
	const top = (payload && typeof payload === 'object' ? payload : {}) as Loose
	const code = (v: unknown): string | null => (v === undefined || v === null ? null : diagnosticCode(v))
	const parts: string[] = []
	// the shape, as field names only (v162 §182): the envelope keys and the result code, so an unrecognised answer is visible in the log
	const envelopeKeys = Object.keys(top).filter((k) => /^[A-Za-z_]{1,30}$/.test(k)).sort().join(',')
	if (envelopeKeys) parts.push(`envelope=${envelopeKeys}`)
	const resultCode = code(r?.code)
	if (resultCode !== null) parts.push(`resultCode=${resultCode}`)
	const notReady = code(r?.notReadyReason ?? top.notReadyReason)
	const cause = code(r?.unreadableCause ?? top.unreadableCause)
	const retryable = typeof (r?.retryable ?? top.retryable) === 'boolean' ? String(r?.retryable ?? top.retryable) : null
	if (notReady !== null) parts.push(`notReadyReason=${notReady}`)
	if (retryable !== null) parts.push(`retryable=${retryable}`)
	if (cause !== null) parts.push(`unreadableCause=${cause}`)
	return parts.length ? ' ' + parts.join(' ') : ''
}

/**
 * The retryable flag of a superseded envelope not_ready (v168 §188.2): the envelope's boolean when present; otherwise by the reason's
 * meaning (storage_locked and ambiguous_accounts are not retryable; g1_uninitialized is); otherwise bounded (true). Pure.
 */
export function legacyRetryable(payload: Loose): boolean {
	if (typeof payload.retryable === 'boolean') return payload.retryable
	if (payload.notReadyReason === 'storage_locked' || payload.notReadyReason === 'ambiguous_accounts') return false
	return true
}

/** A plaintext mnemonic on the record (the account credential, the recorded rule). */
function recordHasPlaintextMnemonic(record: unknown): boolean {
	return isPlain(record) && typeof record.mnemonicPhrase === 'string' && record.mnemonicPhrase.trim() !== ''
}

export function parseShellRecordRead(payload: Loose | null): ShellRecordRead {
	//2: the ack envelope. ok:false is an envelope-level failure (error = the code). ok:true carries the answer in
	// result.code: ok (with record), absent, error (with sub), migrating. Anything else, or an unknown code, fails closed.
	if (!payload || payload.type !== 'ack') return { status: 'error', reason: 'native_unavailable' }
	// v162 §182.2 / v165 §185: an envelope-level not_ready (ok:false, error "not_ready", the superseded v159/v160 form) is not a valid shape.
	// It carries no class, so it is an explicit error (zero class, notReadyClass), never the endless retry.
	// v168 §188 (compatibility, the superseded form): retryable is taken from the envelope when it is a boolean; without it the answer is
	// bounded (re-reads, then the terminal). Never an endless retry, never a data clear, a key change or an automatic create.
	if (payload.ok !== true && payload.error === 'not_ready' && payload.notReadyReason === 'passcode_not_provided') return { status: 'error', reason: 'passcode_not_provided' }
	if (payload.ok !== true && payload.error === 'not_ready') return { status: 'error', reason: 'not_ready', notReady: { retryable: legacyRetryable(payload), notReadyReason: typeof payload.notReadyReason === 'string' ? payload.notReadyReason : undefined, persistent: false } }
	// the superseded persistent form (v168 §188.2): the terminal; its notReadyReason is kept for the diagnostic when the envelope carries it
	if (payload.ok !== true && payload.error === 'not_ready_persistent') return { status: 'error', reason: 'not_ready_persistent', notReady: { retryable: legacyRetryable(payload), notReadyReason: typeof payload.notReadyReason === 'string' ? payload.notReadyReason : undefined, persistent: true } }
	if (payload.ok !== true) return { status: 'error', reason: typeof payload.error === 'string' ? payload.error : 'native_unavailable' }
	const result = payload.result
	if (!result || typeof result !== 'object') return { status: 'error', reason: 'bad_answer' }
	const r = result as Loose
	if (r.code === 'absent') return { status: 'absent' }
	// v162 §182 / v4: not_ready is result.code under ok:true (with notReadyReason, retryable, unreadableCause); not_ready_persistent is
	// result.code "error" with sub "not_ready_persistent". Both carry the class fields for the ceiling (notReadyClass).
	// SRP v2 / v291 (unit g): the native passcode state is not_ready with notReadyReason passcode_not_provided. It is a pending sync, never a read error.
	if (r.code === 'not_ready' && r.notReadyReason === 'passcode_not_provided') return { status: 'error', reason: 'passcode_not_provided' }
	if (r.code === 'not_ready') return { status: 'error', reason: 'not_ready', notReady: { retryable: r.retryable, notReadyReason: typeof r.notReadyReason === 'string' ? r.notReadyReason : undefined, unreadableCause: typeof r.unreadableCause === 'string' ? r.unreadableCause : undefined, persistent: false } }
	if (r.code === 'error' && r.sub === 'not_ready_persistent') return { status: 'error', reason: 'not_ready_persistent', notReady: { retryable: r.retryable, notReadyReason: typeof r.notReadyReason === 'string' ? r.notReadyReason : undefined, unreadableCause: typeof r.unreadableCause === 'string' ? r.unreadableCause : undefined, persistent: true } }
	if (r.code === 'error') return { status: 'error', reason: typeof r.sub === 'string' ? r.sub : 'error' }
	if (r.code === 'ok') {
		const record = r.record
		if (!record || typeof record !== 'object' || Array.isArray(record)) return { status: 'error', reason: 'bad_answer' }
		// rev is the record's rev (the iOS and Android answers both carry record.rev as an integer; the interface rule, shape v2).
		// result.rev is optional: when it is present it must equal record.rev, or the answer is refused as bad_answer. The record without an
		// integer rev is rev_missing.
		const isRev = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
		const rev = (record as Loose).rev
		if (!isRev(rev)) return { status: 'error', reason: 'rev_missing' }
		if (r.rev !== undefined && r.rev !== rev) return { status: 'error', reason: 'bad_answer' }
		try {
			assertNoPgpPrivate(record)
		} catch {
			return { status: 'error', reason: 'pgp_private_in_payload' }
		}
		// a normal read always carries the W-class fields. A record without them is an error, never absent.
		// the record state; a non-ok state is an error (a hold), never absent.
		// draft 21.6/21.8: copyValidated and eoa are read from the result (not the record). Only a boolean true counts; eoa is lower-case.
		// A native-validated copy (G0) has no EOA private key in it (21.1): its account is checked by validatedCopyAccount, not here.
		const copyValidated = r.copyValidated === true
		const eoa = typeof r.eoa === 'string' && r.eoa.trim() ? r.eoa.trim().toLowerCase() : null
		if (!copyValidated) {
			const state = shellWalletState(record)
			// 0.53.44: a keyless record with no plaintext mnemonic is not refused here.
			// It is returned as keylessRecord, so the start can apply the 11-17 rule (no key + no mnemonic → onboarding, data kept). With a
			// mnemonic on the record a missing key stays needs_native_recovery (a hold, never onboarding).
			if (state === 'needs_native_recovery' && !recordHasPlaintextMnemonic(record)) return { status: 'error', reason: state, keylessRecord: record as Loose }
			if (state !== 'ok') return { status: 'error', reason: state }
		} else if (!Array.isArray((record as Loose).profiles)) {
			return { status: 'error', reason: 'wallet_fields_missing' }
		}
		// walletFieldsRedacted is set only by an older native side; the current side does not send it.
		// the two fields are present only when the native side validated the copy (an unvalidated read keeps its shape).
		return {
			status: 'ok',
			record: canonicalizeProfileKeyIDs(record as Loose),
			rev,
			walletFieldsRedacted: r.walletFieldsRedacted === true,
			...(copyValidated ? { copyValidated, eoa } : {}),
		}
	}
	return { status: 'error', reason: typeof r.code === 'string' ? r.code : 'bad_answer' }
}

/** Reads the answer of a write `ok` with the new rev, or `conflict` with currentRev, or an error code. */
export function parseShellRecordWrite(payload: Loose | null): ShellRecordWrite {
	// HC-LOCK L-WRITE (v10 §3.2): an envelope-level locked is the native lock: named so the storage read classifies it as native_locked.
	if (payload && payload.type === 'ack' && payload.ok === false && payload.error === 'locked') return { status: 'error', reason: 'shell_record_locked' }
	// v169 §189: a write answers not_ready only (no persistent form). The superseded envelope not_ready follows v168 §188.2 (legacyRetryable).
	// SRP v2 SRP-02 (unit g): the envelope not_ready with notReadyReason passcode_not_provided is the passcode state (pending sync), never a write failure.
	if (payload && payload.type === 'ack' && payload.ok === false && payload.error === 'not_ready' && payload.notReadyReason === 'passcode_not_provided') return { status: 'error', reason: 'passcode_not_provided' }
	if (payload && payload.type === 'ack' && payload.ok === false && payload.error === 'not_ready') {
		return { status: 'error', reason: 'not_ready', notReady: { retryable: legacyRetryable(payload), notReadyReason: typeof payload.notReadyReason === 'string' ? payload.notReadyReason : undefined, persistent: false } }
	}
	// an envelope error keeps its code (v171 §191.2 bad_request, v166 §186 pgp_private_in_payload, v164 §184 origin_refused): a refusal is then
	// never retried (writeFailureDisposition). An envelope without a string error is native_unavailable.
	if (payload && payload.type === 'ack' && payload.ok === false) {
		return { status: 'error', reason: typeof payload.error === 'string' && payload.error.length > 0 ? payload.error : 'native_unavailable' }
	}
	if (!payload || payload.type !== 'ack' || payload.ok !== true) return { status: 'error', reason: 'native_unavailable' }
	const result = payload.result
	if (!result || typeof result !== 'object') return { status: 'error', reason: 'bad_answer' }
	const r = result as Loose
	if (r.code === 'ok' && typeof r.rev === 'number' && Number.isInteger(r.rev)) return { status: 'ok', rev: r.rev }
	if (r.code === 'conflict') return { status: 'conflict', currentRev: typeof r.currentRev === 'number' ? r.currentRev : null }
	if (r.code === 'not_ready' && r.notReadyReason === 'passcode_not_provided') return { status: 'error', reason: 'passcode_not_provided' }
	if (r.code === 'not_ready') {
		return { status: 'error', reason: 'not_ready', notReady: { retryable: r.retryable, notReadyReason: typeof r.notReadyReason === 'string' ? r.notReadyReason : undefined, persistent: false } }
	}
	return { status: 'error', reason: typeof r.code === 'string' ? r.code : 'bad_answer' }
}

/** The not_ready failure reason a write (or the probe read) carries into the deferred retry: the class of the ceiling (v169 §189). */
export function writeNotReadyReason(parsed: { reason: string; notReady?: { retryable: unknown } }): string | null {
	if (parsed.reason !== 'not_ready') return null
	return `shell_record_not_ready_${notReadyClass({ persistent: false, retryable: parsed.notReady?.retryable })}`
}

/**
 * The write's not_ready step (v169 §189, §179.3): the f-th consecutive not_ready failure (f from 1) schedules re-write f after
 * NOT_READY_BOUNDED_DELAYS_MS[f-1] while the class is bounded and f is within the five re-writes; otherwise the explicit error (the
 * intent is kept, the user retries). Pure.
 */
export function notReadyWriteStep(f: number, cls: 'persistent' | 'bounded' | 'zero'): { kind: 'retry'; delayMs: number } | { kind: 'explicit' } {
	if (cls !== 'bounded') return { kind: 'explicit' }
	if (!Number.isInteger(f) || f < 1 || f > NOT_READY_BOUNDED_DELAYS_MS.length) return { kind: 'explicit' }
	return { kind: 'retry', delayMs: NOT_READY_BOUNDED_DELAYS_MS[f - 1] }
}

/**
 * The shell read as the wallet record. `absent`is the only answer that gives null (a confirmed empty
 * store). A record without the W-class fields is an error, never an absent wallet. A redacted read (older native only) and any other
 * answer throw. Errors carry the `shell_record_` prefix that the storage read maps to `unavailable`.
 */
export function shellRecordAsWalletRecord(r: ShellRecordRead): Loose | null {
	if (r.status === 'absent') return null
	if (r.status !== 'ok') {
		// the not_ready class travels in the message (shell_record_not_ready_<class>), so the storage read maps it to its ceiling
		if (r.reason === 'not_ready' && r.notReady) throw new Error(`shell_record_not_ready_${notReadyClass({ persistent: r.notReady.persistent, retryable: r.notReady.retryable })}`)
		throw new Error(`shell_record_${r.reason}`)
	}
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
type DeferredWrite = { ours: Loose | null; ops: DeltaOp[]; rev: number | null; attempts: number; refused?: string; notReady?: number; exhausted?: boolean }

const DELTA_VERSION = 1

let deferred: DeferredWrite | null = null
let deferredTimer: ReturnType<typeof setTimeout> | null = null
let retrying = false
const WRITE_RETRY_MS = 3000
/**
 *a write refused for these codes is a failure. It is not success, the intent
 * is not retried (no silent field drop and no automatic retry), and no other channel is used. Only the code is recorded.
 */
const WRITE_REFUSAL_CODES: ReadonlySet<string> = new Set([
	'key_shaped_content',
	'wallet_copy_not_approved',
	// envelope-level refusals: a bad request (including an over-size request, v171 §191.2), a payload with a PGP private key (v166 §186) and
	// an untrusted origin (v164 §184) are refusals of the request, never retried on any path
	'bad_request',
	'pgp_private_in_payload',
	'origin_refused',
])
/**
 * How a failed write is handled (v169 §189, v171 §191.2): 'refused' (a refusal of the request: kept, never retried), 'not_ready' (the
 * not_ready ceiling), or 'retry' (the ordinary backoff). Pure.
 */
export function writeFailureDisposition(reason: string): 'refused' | 'not_ready' | 'retry' | 'pending_sync' {
	// Unit g (rev): passcode_not_provided is a pending sync (the native side waits for the passcode). It is neither a write failure, nor a refusal,
	// nor an exhausted retry: the intent is kept and not counted.
	if (reason === 'passcode_not_provided') return 'pending_sync'
	if (WRITE_REFUSAL_CODES.has(reason)) return 'refused'
	if (reason.startsWith('shell_record_not_ready_')) return 'not_ready'
	return 'retry'
}

/** Whether a write failure reason is a refusal of the request (never retried). Pure. */
export function isWriteRefusalCode(code: string): boolean {
	return WRITE_REFUSAL_CODES.has(code)
}

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
				s.setItem(DEFERRED_WRITE_KEY, JSON.stringify({ v: DELTA_VERSION, rev: deferred.rev, ops: deferred.ops, ours: deferred.ours ?? null, attempts: deferred.attempts, refused: deferred.refused ?? null, notReady: deferred.notReady ?? 0, exhausted: deferred.exhausted ?? false }))
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
		const o = JSON.parse(raw) as { v?: unknown; rev?: unknown; ops?: unknown; ours?: unknown; attempts?: unknown; refused?: unknown; notReady?: unknown; exhausted?: unknown }
		if (o.v !== DELTA_VERSION || !Array.isArray(o.ops)) return null
		return {
			// the page's full copy of a first write survives a restart (it is the sanitized copy: no wallet field, no PGP private)
			ours: o.ours && typeof o.ours === 'object' && !Array.isArray(o.ours) ? (o.ours as Loose) : null,
			ops: o.ops as DeltaOp[],
			rev: typeof o.rev === 'number' ? o.rev : null,
			attempts: typeof o.attempts === 'number' ? o.attempts : 0,
			...(typeof o.refused === 'string' && WRITE_REFUSAL_CODES.has(o.refused) ? { refused: o.refused } : {}),
			...(typeof o.notReady === 'number' ? { notReady: o.notReady } : {}),
			...(o.exhausted === true ? { exhausted: true } : {}),
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
/**
 * A not_ready failure of a direct write (v169 §189): the intent is deferred and the not_ready ceiling runs on it (five re-writes on
 * 0.5, 1, 2, 4, 8 s for a retryable answer; the explicit error at once for a non-retryable one). The first timer uses the ceiling delay.
 */
function deferNotReadyWrite(ops: DeltaOp[], ours: Loose | null, reason: string): void {
	deferWrite(ops, ours)
	const d = deferred
	if (d !== null) notReadyFailure(d, reason.slice('shell_record_not_ready_'.length) as 'persistent' | 'bounded' | 'zero')
	if (deferredTimer !== null) {
		clearTimeout(deferredTimer)
		deferredTimer = null
	}
	scheduleDeferredRetry()
}

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

/** A first write waiting for the native key (the gate is closed): no timer, no counted attempt. It is retried when the gate opens. */
function waitingForNativeKey(pending: DeferredWrite): boolean {
	return pending.ours !== null && basisRev === 0 && !firstWriteAllowed(pending.ours)
}

function scheduleDeferredRetry(): void {
	if (deferredTimer !== null || retrying || deferred === null) return
	if (waitingForNativeKey(deferred)) return
	//a refused intent is not retried automatically (on a timer, after a restart or after a read).
	if (deferred.refused !== undefined) return
	// the not_ready ceiling is exhausted: the explicit error; the user's retry starts a new ladder (retryDeferredWriteNow)
	if (deferred.exhausted) return
	const delay = deferred.notReady
		? NOT_READY_BOUNDED_DELAYS_MS[Math.min(deferred.notReady, NOT_READY_BOUNDED_DELAYS_MS.length) - 1]
		: backoffDelayMs(WRITE_RETRY_MS, deferred.attempts)
	deferredTimer = setTimeout(() => {
		deferredTimer = null
		void retryDeferredWrite()
	}, delay)
}

/** A not_ready failure of the deferred write (v169 §189): bounded re-writes on the §179.3 ladder, then the explicit error. Nothing is cleared. */
/**
 * The state after one more not_ready write failure (v169 §189.4): the consecutive count rises by one; a bounded class within the five
 * re-writes schedules the next (its delay), otherwise the explicit error (exhausted). Never a persistent class for a write. Pure.
 */
export function nextNotReadyState(prevCount: number, cls: 'persistent' | 'bounded' | 'zero'): { count: number; step: { kind: 'retry'; delayMs: number } | { kind: 'explicit' } } {
	const count = prevCount + 1
	return { count, step: notReadyWriteStep(count, cls) }
}

function notReadyFailure(pending: DeferredWrite, cls: 'persistent' | 'bounded' | 'zero'): void {
	if (deferred !== pending) return
	const { count: f, step } = nextNotReadyState(pending.notReady ?? 0, cls)
	if (step.kind === 'retry') {
		deferred = { ...pending, notReady: f }
		publishNativePwaLog('info', `[shellRecord] write not_ready (bounded): re-write ${f} of ${NOT_READY_BOUNDED_DELAYS_MS.length} in ${step.delayMs} ms`)
	} else {
		deferred = { ...pending, notReady: f, exhausted: true }
		publishNativePwaLog('warn', `[shellRecord] write not_ready (${cls}): explicit error; the intent is kept, nothing cleared or replaced; the user retries`)
	}
	persistDeferred()
}

function countAttempt(pending: DeferredWrite): void {
	if (deferred !== pending) return
	deferred = { ...pending, attempts: pending.attempts + 1, notReady: 0 }
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

/** The deferred write retried now (the entry calls it once the native sync is confirmed; tests use it as the timer's effect). */
export async function retryDeferredWriteNow(): Promise<void> {
	// the user's retry after an explicit not_ready error: a fresh ladder (the intent is unchanged)
	if (deferred !== null && deferred.exhausted) {
		deferred = { ...deferred, exhausted: false, notReady: 0 }
		persistDeferred()
	}
	await retryDeferredWrite()
}

async function retryDeferredWrite(): Promise<void> {
	const pending = deferred ?? loadDeferred()
	if (!pending) return
	deferred = pending
	retrying = true
	try {
		// A probe read: it completes a read and the answer is merged here; it does not move the copy basis. Raw: the intent is applied here.
		const read = await shellRecordRead({ probe: true, raw: true, source: 'deferred' })
		if (read.status !== 'ok' && read.status !== 'absent') {
			if (read.reason === 'not_ready') {
				notReadyFailure(pending, notReadyClass({ persistent: false, retryable: read.notReady?.retryable }))
				return
			}
			// Unit g (rev 2): a passcode_not_provided read is a pending sync: the intent is kept and not counted (not an exhausted retry, not a refusal).
			if (read.reason === 'passcode_not_provided') {
				publishNativePwaLog('info', `[shellRecord] read pending sync (${diagnosticCode('passcode_not_provided')}): kept, not counted`)
				return
			}
			if (WRITE_REFUSAL_CODES.has(read.reason)) {
				if (deferred === pending) {
					deferred = { ...pending, attempts: pending.attempts + 1, refused: read.reason }
					persistDeferred()
				}
				return
			}
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
			// the gate is closed: nothing is written and the attempt is not counted (retried when the gate opens)
			if (!firstWriteAllowed(pending.ours)) return
			payload = pending.ours
			rev = 0
		}
		const out = await writeAt(payload, rev)
		if (out.status === 'failed' && writeFailureDisposition(out.reason) === 'pending_sync') {
			// pending sync: the intent is kept as it is; no attempt is counted and no failure or refusal is recorded.
			publishNativePwaLog('info', `[shellRecord] write pending sync (${diagnosticCode('passcode_not_provided')}): kept, not counted, not a failure`)
			return
		}
		if (out.status === 'failed' && writeFailureDisposition(out.reason) === 'not_ready') {
			notReadyFailure(pending, out.reason.slice('shell_record_not_ready_'.length) as 'persistent' | 'bounded' | 'zero')
			return
		}
		if (out.status === 'ok') {
			// the copy basis does not move here. The page copy still derives from the basis it was made on; moving it to the
			// merged record would make the next save treat the stale copy's values as page changes and overwrite the imported ones.
			noteApplied(pending.ops)
			clearDeferred(pending)
			return
		}
		if (out.status === 'failed' && writeFailureDisposition(out.reason) === 'refused') {
			//the store refused the write. A failure, never a success; the intent is kept with the code and not retried.
			if (deferred === pending) {
				deferred = { ...pending, attempts: pending.attempts + 1, refused: out.reason }
				persistDeferred()
			}
			publishNativePwaLog('info', `[shellRecord] write refused by the store (${diagnosticCode(out.reason)}); not retried`)
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
	const notReady = writeNotReadyReason(parsed)
	if (notReady !== null) return { status: 'failed', reason: notReady }
	return { status: 'failed', reason: parsed.reason }
}

/** Reads the sanitized record from the native store. Never throws: a missing bridge or a bad answer is an error. */
/**
 * A read of the record. The record returned is the page's view: the stored record with the page's held change applied (H1, and for
 * a probe too), so a copy that a probe feeds keeps the change. A probe does not move the copy basis. `raw` returns the stored record
 * as it is, for a write that applies its own intent (the retry and the removals).
 */
/** A label for the diagnostics log only: which caller issued the read. Never a value. */
export type ShellReadSource = 'init' | 'probe' | 'deferred' | 'removal' | 'unlabeled'

/**
 * 0.53.44: a read request is open until its reply or the hard cap. The soft mark (10 s)
 * only logs "still waiting": a transport timeout at 10 s is not an answer, so a late ok reply reaches the read in flight. One read request is
 * open at a time: every caller meanwhile shares it (no second reqId is sent).
 */
export const SHELL_READ_HARD_CAP_MS = 30_000
export const SHELL_READ_STILL_WAITING_MS = 10_000
let openReadAnswer: Promise<ShellRecordAnswer> | null = null
function sharedReadAnswer(src: string): Promise<ShellRecordAnswer> {
	if (openReadAnswer) return openReadAnswer
	const reqId = nextReqId()
	const stillWaiting = setTimeout(() => publishNativePwaLog('info', `[shellRecordRead] still waiting source=${src} at 10 s (request open to 30 s)`), SHELL_READ_STILL_WAITING_MS)
	const open: Promise<ShellRecordAnswer> = sendShellRecordCommand(buildShellRecordReadCommand(reqId), SHELL_READ_HARD_CAP_MS).finally(() => {
		clearTimeout(stillWaiting)
		if (openReadAnswer === open) openReadAnswer = null
	})
	openReadAnswer = open
	return open
}

export async function shellRecordRead(options: { probe?: boolean; raw?: boolean; source?: ShellReadSource } = {}): Promise<ShellRecordRead> {
	// Diagnostics (S25, 2026-11-15): reason codes and times only. No record, key or field value is logged.
	const sentAt = Date.now()
	const src = options.source ?? 'unlabeled'
	if (!openReadAnswer) publishNativePwaLog('info', `[shellRecordRead] sent source=${src} at ${new Date(sentAt).toISOString()}`)
	else publishNativePwaLog('info', `[shellRecordRead] shares the open request source=${src} (no second request)`)
	const answer = await sharedReadAnswer(src)
	if (answer.kind !== 'payload') {
		const reason = transportReason(answer)
		publishNativePwaLog('warn', `[shellRecordRead] no answer source=${src}: reason=${diagnosticCode(reason)} ms=${Date.now() - sentAt}`)
		return { status: 'error', reason }
	}
	const parsed = parseShellRecordRead(answer.payload)
	publishNativePwaLog(
		parsed.status === 'error' ? 'warn' : 'info',
		`[shellRecordRead] returned source=${src} status=${parsed.status}${parsed.status === 'error' ? ` reason=${diagnosticCode(parsed.reason)}` : ''}${shellReadDiagnosticFields(answer.payload)} ms=${Date.now() - sentAt}`,
	)
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
	const read = await shellRecordRead({ probe: true, raw: true, source: 'removal' })
	if (read.status === 'absent') return true
	if (read.status === 'ok') {
		const payload = applyDelta(withBeamio(sanitizedCopy(read.record)), removals).record
		const out = await writeAt(payload, read.rev)
		if (out.status === 'ok') {
			noteApplied(removals)
			return true
		}
		if (out.status === 'failed' && out.reason.startsWith('shell_record_not_ready_')) deferNotReadyWrite(removals, null, out.reason)
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
/**
 * a first write that creates the native record (the store is absent) waits for the native pwaWalletSync of the same
 * account to be confirmed ok. Until then the page's copy has no key on the native side (the write strips the wallet fields), so a record
 * created now would hold no key. The gate is in memory: it opens once per session, on the sync's confirmation.
 */
let firstWriteKeyEoa: string | null = null
export function allowFirstNativeWrite(eoa: string): void {
	firstWriteKeyEoa = String(eoa ?? '').trim().toLowerCase() || null
}
function firstWriteAllowed(rec: Loose): boolean {
	if (firstWriteKeyEoa === null) return false
	const first = Array.isArray(rec.profiles) ? (rec.profiles[0] as Loose | undefined) : undefined
	return typeof first?.keyID === 'string' && first.keyID.trim().toLowerCase() === firstWriteKeyEoa
}

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
		// The first write of a record (the store is absent): the page's full copy creates it, once the native key is confirmed (see the gate).
		if (!firstWriteAllowed(ours)) {
			deferWrite([], ours)
			return
		}
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
		if (out.status === 'failed' && out.reason.startsWith('shell_record_not_ready_')) deferNotReadyWrite([], ours, out.reason)
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
	// HC-LOCK L-WRITE: a locked write is not written and the change is kept (deferred), to be written after the unlock.
	if (out.status === 'failed' && out.reason === 'shell_record_locked') {
		deferWrite(writeOps, null)
		throw new Error(out.reason)
	}
	if (out.status === 'failed' && out.reason.startsWith('shell_record_not_ready_')) deferNotReadyWrite(writeOps, null, out.reason)
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

/**
 * Draft 22.3: the isolation of a key-only page copy, before the page writes a new account. The request is {type, reqId, keyID}. The answer is
 * ok with quarantined true and an auditRef, or a refusal, or unknown (a read or write failure, or a native command that is not supported).
 * Nothing is deleted by this command; the old copy is renamed and kept, with an audit entry (native side).
 */
export const SHELL_RECORD_QUARANTINE_KEY_ONLY = 'shellRecordQuarantineKeyOnly'
export type KeyOnlyQuarantine =
	| { status: 'quarantined'; auditRef: string }
	| { status: 'refused'; reason: string }
	| { status: 'unknown'; reason: string }

export function buildQuarantineKeyOnlyCommand(reqId: number, keyID: string): { type: string; reqId: number; keyID: string } {
	return { type: SHELL_RECORD_QUARANTINE_KEY_ONLY, reqId, keyID }
}

/** Pure: maps the transport answer of the isolation command to its outcome. Anything not clearly ok or refused is unknown (fail closed). */
export function parseQuarantineAnswer(answer: ShellRecordAnswer): KeyOnlyQuarantine {
	if (answer.kind !== 'payload') return { status: 'unknown', reason: transportReason(answer) }
	const p = answer.payload as Loose | null
	if (!p || p.type !== 'ack') return { status: 'unknown', reason: 'native_unavailable' }
	if (p.ok !== true) return { status: 'unknown', reason: typeof p.error === 'string' ? p.error : 'native_unavailable' }
	const r = p.result as Loose | null
	if (!r || typeof r !== 'object') return { status: 'unknown', reason: 'bad_answer' }
	if (r.code === 'ok' && r.quarantined === true && typeof r.auditRef === 'string' && r.auditRef.trim()) {
		return { status: 'quarantined', auditRef: r.auditRef }
	}
	if (r.code === 'refused') return { status: 'refused', reason: typeof r.reason === 'string' ? r.reason : 'refused' }
	return { status: 'unknown', reason: typeof r.reason === 'string' ? r.reason : 'bad_answer' }
}

/** Sends the isolation command for one key-only copy. `send` is injectable for the tests; the app uses the shell record transport. */
export async function quarantineKeyOnlyShellRecord(
	keyID: string,
	send: (cmd: { type: string; reqId: number; keyID: string }, timeoutMs: number) => Promise<ShellRecordAnswer> = (cmd, t) => sendShellRecordCommand(cmd, t),
): Promise<KeyOnlyQuarantine> {
	const id = (keyID || '').trim().toLowerCase()
	if (!/^0x[0-9a-f]{40}$/.test(id)) return { status: 'refused', reason: 'bad_key_id' }
	const answer = await send(buildQuarantineKeyOnlyCommand(nextReqId(), id), TIMEOUT_MS)
	return parseQuarantineAnswer(answer)
}

/**
 * Draft 21.6 to 21.8: the page routes to /home on the native check only when the read carries copyValidated true (a boolean),
 * eoa equal to the account keyID (lower case), and a mnemonic field in the record. The page never derives the key here.
 * Pure. The record's W-class fields are not the marker.
 */
export function validatedCopyAccount(read: { copyValidated?: boolean; eoa?: string | null; record: Loose }): boolean {
	if (read.copyValidated !== true) return false
	const profiles = read.record.profiles
	const first = Array.isArray(profiles) ? profiles[0] : undefined
	const keyID = isPlain(first) && typeof first.keyID === 'string' ? first.keyID.trim().toLowerCase() : ''
	if (!keyID || !read.eoa || read.eoa !== keyID) return false
	// the copy's mnemonic must pass the BIP-39 checksum (no derivation here); recoveryWords alone do not count.
	// The keyID is checked against the native walletEoaAddress (read.eoa) above.
	const phrase = typeof read.record.mnemonicPhrase === 'string' ? read.record.mnemonicPhrase.trim() : ''
	return isMnemonicPhrase(phrase)
}

/**
 * Draft 22.4: a fresh account write over a key-only copy (native no_key, no mnemonic, both sides confirmed) isolates the old copy first.
 * `isKeyOnly` is the page's confirmation of the copy. A stored record that is not key-only is left to the editable-field path (no
 * full write). Any read failure or refusal throws before anything is written. Returns whether the old copy was isolated.
 */
export async function prepareShellFreshWrite(
	isKeyOnly: (rec: Loose) => boolean,
	newKeyID: string | undefined,
	send?: (cmd: { type: string; reqId: number; keyID: string }, timeoutMs: number) => Promise<ShellRecordAnswer>,
): Promise<{ isolated: boolean }> {
	// a probe: the decision does not move the copy basis (the isolation sets it when the old copy is gone).
	const current = await shellRecordRead({ probe: true, source: 'probe' })
	if (current.status === 'absent') return { isolated: false }
	if (current.status !== 'ok') throw new Error(`fresh_write_read_${current.reason}`)
	if (!isKeyOnly(current.record)) return { isolated: false }
	const profiles = current.record.profiles
	const first = Array.isArray(profiles) ? profiles[0] : undefined
	const keyID = isPlain(first) && typeof first.keyID === 'string' ? first.keyID : ''
	// the account being written is the one the copy holds (a restore of the same account): nothing is a new account, nothing is isolated.
	if (newKeyID && keyID.trim().toLowerCase() === newKeyID.trim().toLowerCase()) return { isolated: false }
	const out = await quarantineKeyOnlyShellRecord(keyID, send)
	if (out.status !== 'quarantined') {
		publishNativePwaLog('warn', `[shellRecord] key-only copy not isolated (${out.status}: ${out.status === 'refused' ? out.reason : 'retry'}); nothing written`)
		throw new Error(`key_only_not_isolated_${out.status}`)
	}
	publishNativePwaLog('info', '[shellRecord] key-only copy isolated (audit written); the account is written as a new record')
	// the old copy is gone from the store: the next write is the page's full copy at revision 0 (the store is absent).
	basisRev = 0
	basisRecord = null
	blocked = false
	ownEdits.clear()
	ownRemovals.clear()
	deferred = null
	persistDeferred()
	return { isolated: true }
}
