/**
 * plan A, PWA side. The page sends three commands and reads
 * the answers. It never sends a key, an armor, a passphrase, a backup or a chain basis, and it never generates, registers or
 * overwrites a PGP key by itself. The native layer decides every state and writes every key.
 *
 * - `pgpRestoreEvaluate`: read-only evaluation. Run when identityPublic answers `pgpReady: false`. It is not a restore.
 * - `pgpRestore`: restores the original identity, but only after an evaluation said `ok` (the native layer checks the fingerprint).
 * - `pgpIdentityCreate`: the user's explicit click on the failure entry. The native layer shows its own confirmation and decides
 * the mode (replace or first identity); the page does not choose it.
 *
 * Every command is sent with `{type, reqId, accountKey}` (plus `idempotencyKey` for create) and nothing else. Answers and events
 * carry no key material; the codes are the ones in.
 */
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { eventPayloadOf, NATIVE_EVENT_NAMES, NATIVE_QUERY_REQ_BASE } from './nativeKeyState'
import type { PgpRestoreFailure } from './pgpRestore'
import { PGP_IDENTITY_CREATE_ENABLED } from '../utils/pgpIdentityCreateFlag'
import { CHAIN_REGISTRATION_STATES, LEGACY_REPORT_STATES, pgpCreateEligible, type ChainRegistrationState, type LegacyReportState } from './pgpIdentityEligibility'

export const NATIVE_PGP_EVALUATE_COMMAND = 'pgpRestoreEvaluate'
export const NATIVE_PGP_RESTORE_COMMAND = 'pgpRestore'
export const NATIVE_PGP_CREATE_COMMAND = 'pgpIdentityCreate'
export const PGP_RESTORE_RESULT_EVENT = 'pgpRestoreResult'
export const PGP_IDENTITY_CREATE_RESULT_EVENT = 'pgpIdentityCreateResult'

/** PGP commands use the gate-query range after the identityPublic part (see nativeKeyState). */
const PGP_REQ_OFFSET = 10_000_000
let pgpSeq = 0
const nextPgpReqId = (): number => {
	pgpSeq += 1
	return NATIVE_QUERY_REQ_BASE + PGP_REQ_OFFSET + pgpSeq
}

const EVALUATE_TIMEOUT_MS = 15_000
const RESTORE_TIMEOUT_MS = 90_000
/** The native confirmation waits up to 120 s (第 2 条); the page waits a little longer. */
const CREATE_TIMEOUT_MS = 150_000

type Loose = Record<string, unknown>

export type PgpEvalState = 'ok' | 'failed' | 'undetermined' | 'first_identity'
export type PgpFailureClass = 'backup_missing' | 'decrypt_failed' | 'fingerprint_mismatch' | 'registration_missing'

const EVAL_STATES: readonly string[] = ['ok', 'failed', 'undetermined', 'first_identity']
const FAILURE_CLASSES: readonly string[] = ['backup_missing', 'decrypt_failed', 'fingerprint_mismatch', 'registration_missing']
/** Ack refusals of the PGP commands. They never reach the screen as a state. */
const REFUSAL_CODES: readonly string[] = [
	'bad_request',
	'key_over_bridge_refused',
	'confirmation_not_native',
	'account_mismatch',
	'no_key',
	'locked',
	'already_exists',
	'pending_exists',
	'pgp_source_unavailable',
	//1: the chain write path is not approved; the refusal is at the ack only (no result event).
	'waiting_registration',
]

/** Maps a native failure class to the page's failure code (the Chat route shows it). */
export function failureCodeOf(cls: PgpFailureClass): PgpRestoreFailure {
	switch (cls) {
		case 'backup_missing':
			return 'pgp_backup_missing'
		case 'decrypt_failed':
			return 'pgp_backup_undecryptable'
		case 'fingerprint_mismatch':
			return 'pgp_fingerprint_mismatch'
		case 'registration_missing':
			return 'pgp_registration_missing'
	}
}

export type PgpEvaluation =
	| { kind: 'evaluated'; state: PgpEvalState; failureCode: PgpRestoreFailure | null; offerEntry: boolean; legacy?: LegacyReportState; chain?: ChainRegistrationState }
	| { kind: 'refused'; code: string }
	| { kind: 'unavailable' }
	/**1: a temporary state (undetermined). Retried, never terminal, never a missing PGP. */
	| { kind: 'source_unavailable' }

/** The legacy and chain fields (RULING 617d3dd9): a missing or unknown value is unknown, never a confirmation. */
function fieldsOf(r: Loose): { legacy: LegacyReportState; chain: ChainRegistrationState } {
	const legacy = typeof r.legacy === 'string' && LEGACY_REPORT_STATES.includes(r.legacy) ? (r.legacy as LegacyReportState) : 'unknown'
	const chain = typeof r.chain === 'string' && CHAIN_REGISTRATION_STATES.includes(r.chain) ? (r.chain as ChainRegistrationState) : 'unknown'
	return { legacy, chain }
}

/** Reads the evaluation result. Only the known fields are read; a value that is not in the spec is `unavailable`, never echoed. */
export function parsePgpEvaluateResult(result: unknown): PgpEvaluation {
	if (!result || typeof result !== 'object') return { kind: 'unavailable' }
	const r = result as Loose
	if (typeof r.state !== 'string' || !EVAL_STATES.includes(r.state)) return { kind: 'unavailable' }
	const state = r.state as PgpEvalState
	const cls = r.failureClass
	if (cls === null || cls === undefined) {
		if (state === 'failed') return { kind: 'unavailable' }
		return { kind: 'evaluated', state, failureCode: null, offerEntry: r.offerEntry === true, ...fieldsOf(r) }
	}
	if (typeof cls !== 'string' || !FAILURE_CLASSES.includes(cls)) return { kind: 'unavailable' }
	return { kind: 'evaluated', state, failureCode: failureCodeOf(cls as PgpFailureClass), offerEntry: r.offerEntry === true, ...fieldsOf(r) }
}

/** Sends one PGP command as an ack request. The reply is an ack envelope; anything else is `unavailable`. */
async function ackFor(cmd: Loose, timeoutMs: number, reqId: number): Promise<{ kind: 'ok'; result: unknown } | { kind: 'refused'; code: string } | { kind: 'unavailable' }> {
	const answer = await requestNativeAck(cmd, timeoutMs, reqId)
	if (answer.kind !== 'payload') return { kind: 'unavailable' }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
	if (p.type !== 'ack') return { kind: 'unavailable' }
	if (p.ok === true) return { kind: 'ok', result: p.result }
	const code = typeof p.error === 'string' ? p.error : ''
	// not_ready is unknown and retryable: the code is returned as-is and evaluate maps it to the temporary
	// source state (never a terminal result).
	if (code === PGP_NOT_READY) return { kind: 'refused', code }
	return REFUSAL_CODES.includes(code) ? { kind: 'refused', code } : { kind: 'refused', code: 'unknown_ack' }
}

/**
 * Waits for the result event with this reqId. The listener is registered before the command is sent, so a fast answer is not
 * missed. Resolves with the event's `code`, or `timeout`.
 */
function waitForResult(eventType: string, reqId: number, timeoutMs: number): { promise: Promise<string>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined
	let done: ((code: string) => void) | undefined
	const listener = (ev: Event) => {
		const payload = eventPayloadOf(ev)
		if (!payload || payload.type !== eventType || payload.reqId !== reqId) return
		done?.(typeof payload.code === 'string' ? payload.code : 'unknown_result')
	}
	const cleanup = () => {
		for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
		if (timer !== undefined) clearTimeout(timer)
	}
	const promise = new Promise<string>((resolve) => {
		done = (code) => {
			cleanup()
			resolve(code)
		}
		timer = setTimeout(() => done?.('timeout'), timeoutMs)
	})
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
	return { promise, cancel: cleanup }
}

/** The code of a temporary source state (1.1): retried, not a terminal result. It appears as the ack error or in result.code. */
export const PGP_SOURCE_UNAVAILABLE = 'pgp_source_unavailable'
/**
 *43608b3d): `not_ready` is unknown and retryable. It is the same temporary state as pgp_source_unavailable: no
 * missing key is concluded, no new PGP is generated, no success is shown, and the usual backoff and manual retry apply.
 */
export const PGP_NOT_READY = 'not_ready'
const isTemporarySourceCode = (code: string): boolean => code === PGP_SOURCE_UNAVAILABLE || code === PGP_NOT_READY

/** The evaluation of an answer body (the event or the ack's result): the temporary source state, or the state the body carries. */
function evaluationOf(body: Loose): PgpEvaluation {
	if (typeof body.code === 'string' && isTemporarySourceCode(body.code)) return { kind: 'source_unavailable' }
	return parsePgpEvaluateResult(body)
}

/**
 * Read-only evaluation (`pgpRestoreEvaluate`). Writes nothing, on either side. The result is in the ack: `result` carries state,
 * failureClass, code, offerEntry and uiKey. The evaluate has no result event; no event is awaited here.
 */
export async function evaluateNativePgpRestore(accountKey: string): Promise<PgpEvaluation> {
	if (typeof window === 'undefined' || !accountKey) return { kind: 'unavailable' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered || !probe.capabilities.includes(NATIVE_KEYS_CAPABILITY)) return { kind: 'unavailable' }
	const reqId = nextPgpReqId()
	const a = await ackFor({ type: NATIVE_PGP_EVALUATE_COMMAND, accountKey }, EVALUATE_TIMEOUT_MS, reqId)
	if (a.kind === 'unavailable') return { kind: 'unavailable' }
	if (a.kind === 'refused') return isTemporarySourceCode(a.code) ? { kind: 'source_unavailable' } : { kind: 'refused', code: a.code }
	const body = a.result && typeof a.result === 'object' ? (a.result as Loose) : null
	if (!body) return { kind: 'unavailable' }
	return evaluationOf(body)
}

export type PgpRestoreOutcome = { ok: true } | { ok: false; code: string; failure: PgpRestoreFailure | null }

/**
 * Restores the original identity (`pgpRestore`) and waits for `pgpRestoreResult`. The page calls it only after an evaluation of
 * `ok`; a `pgpReady: false` answer alone never starts it.
 */
export async function restoreNativePgp(accountKey: string): Promise<PgpRestoreOutcome> {
	if (typeof window === 'undefined' || !accountKey) return { ok: false, code: 'unavailable', failure: null }
	const probe = await probeNativeCapabilities()
	if (!probe.answered || !probe.capabilities.includes(NATIVE_KEYS_CAPABILITY)) return { ok: false, code: 'unavailable', failure: null }
	const reqId = nextPgpReqId()
	const waiter = waitForResult(PGP_RESTORE_RESULT_EVENT, reqId, RESTORE_TIMEOUT_MS)
	const a = await ackFor({ type: NATIVE_PGP_RESTORE_COMMAND, accountKey }, EVALUATE_TIMEOUT_MS, reqId)
	if (a.kind !== 'ok') {
		waiter.cancel()
		return { ok: false, code: a.kind === 'refused' ? a.code : 'unavailable', failure: null }
	}
	const code = await waiter.promise
	if (code === 'ok') return { ok: true }
	return { ok: false, code, failure: codeToFailure(code) }
}

/** Result codes that name a failure the Chat route shows. Anything else is retried, not shown. */
function codeToFailure(code: string): PgpRestoreFailure | null {
	switch (code) {
		case 'pgp_backup_missing':
			return 'pgp_backup_missing'
		case 'pgp_backup_undecryptable':
		case 'pgp_backup_invalid':
			return 'pgp_backup_undecryptable'
		case 'pgp_fingerprint_mismatch':
			return 'pgp_fingerprint_mismatch'
		case 'pgp_registration_missing':
			return 'pgp_registration_missing'
		default:
			return null
	}
}

export type PgpCreateOutcome = { ok: true; mode?: string } | { ok: false; reason: string }

/** A new idempotency key for one user click (第 4 条). A repeat of the same click reuses the key. */
export function newIdempotencyKey(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	if (c && typeof c.randomUUID === 'function') return c.randomUUID()
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * The user's click on the failure entry (`pgpIdentityCreate`). The native layer shows its own confirmation, checks the chain, and
 * answers; the result comes as `pgpIdentityCreateResult`. `ok` and `idempotent` both mean the identity was written once.
 */
/** Build-time switch: true only in the QA build; see pgpIdentityCreateFlag.ts. While false, the click sends no command. */
export { PGP_IDENTITY_CREATE_ENABLED }

export async function nativeGenerateNewPgpKey(accountKey: string, idempotencyKey: string = newIdempotencyKey()): Promise<PgpCreateOutcome> {
	// RULING 617d3dd9: the command is refused without the first-identity confirmation, in every build (no send).
	if (!pgpCreateEligible(accountKey)) return { ok: false, reason: 'not_eligible' }
	if (!PGP_IDENTITY_CREATE_ENABLED) return { ok: false, reason: 'not_enabled' }
	return sendNativePgpIdentityCreate(accountKey, idempotencyKey)
}

/** The wire path of pgpIdentityCreate. Not reached while PGP_IDENTITY_CREATE_ENABLED is false. */
export async function sendNativePgpIdentityCreate(accountKey: string, idempotencyKey: string): Promise<PgpCreateOutcome> {
	if (!accountKey) return { ok: false, reason: 'no_account' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered || !probe.capabilities.includes(NATIVE_KEYS_CAPABILITY)) return { ok: false, reason: 'native_unavailable' }
	const reqId = nextPgpReqId()
	const waiter = waitForResult(PGP_IDENTITY_CREATE_RESULT_EVENT, reqId, CREATE_TIMEOUT_MS)
	const a = await ackFor({ type: NATIVE_PGP_CREATE_COMMAND, accountKey, idempotencyKey }, EVALUATE_TIMEOUT_MS, reqId)
	if (a.kind !== 'ok') {
		waiter.cancel()
		return { ok: false, reason: a.kind === 'refused' ? a.code : 'native_unavailable' }
	}
	const mode = (a.result as Loose | undefined)?.mode
	const code = await waiter.promise
	if (code === 'ok' || code === 'idempotent') return { ok: true, mode: typeof mode === 'string' ? mode : undefined }
	return { ok: false, reason: code }
}
