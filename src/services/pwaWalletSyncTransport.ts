/**
 *the page side of `pwaWalletSync` and `nativeMnemonicPreread`.
 *
 * Request: {type:"pwaWalletSync", reqId, eoa, phrase, seq}. `trustedOrigin` is set by the shell, never by the page.
 * The mnemonic is sent only as `phrase`, never logged. A retry of the same transaction reuses its reqId and seq.
 *
 * Reply (the flat envelope {type:"ack", reqId, ok, result? | error?, reason?}):
 * ok:true result.sync = updated | idempotent → ok
 * ok:false error = untrusted_source | key_over_bridge_refused | bad_request | stale_seq → that code
 * ok:false error = write_failed, reason = internal_state | storage_write → write_failed (+reason)
 * anything else, a malformed ok, a timeout, no channel → no_answer (the page's own unknown: retryable)
 * A refused page origin is untrusted_source (not retried). There is no wire "unknown" answer.
 * `reason` sits beside `error` (the spec's draft placement; 第 1(a) is read as the same level, to be confirmed).
 */
import { sendShellWalletSyncCommand, shellRecordTransportKind } from './shellRecordTransport'
import type { ShellSyncAnswer } from './shellMnemonicSync'
import { canonicalPhrase } from './mnemonicCanonical'
import { mnemonicEoa } from './shellLegacyIdbInit'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { prereadReqIdFor, pwaWalletSyncReqIdFor } from './reqIdSpaces'

const ERROR_CODES: ReadonlySet<string> = new Set(['untrusted_source', 'key_over_bridge_refused', 'bad_request', 'stale_seq', 'write_failed', 'locked'])
const SYNC_RESULTS: ReadonlySet<string> = new Set(['updated', 'idempotent'])
const WRITE_FAILED_REASONS: ReadonlySet<string> = new Set(['internal_state', 'storage_write', 'rollback_pending', 'old_copy_unverified'])
const EOA_RE = /^0x[0-9a-f]{40}$/
const PHRASE_RE = /^[a-z]+( [a-z]+)*$/

/** The reply as the page reads it. `reason` is set for write_failed only. */
export type PwaSyncReply = { code: ShellSyncAnswer; reason?: 'internal_state' | 'storage_write' | 'rollback_pending' | 'old_copy_unverified' }

/** The native preread answer. */
export type PrereadState = 'valid' | 'absent' | 'unknown'

/** The transport can carry the sync (a window channel, or the iOS chat channel). Otherwise the sync is unavailable, not failed. */
export function pwaWalletSyncTransportAvailable(): boolean {
	const kind = shellRecordTransportKind()
	return kind === 'window' || kind === 'chat'
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The request number of a transaction: one reqId per seq, so a retry of the same transaction is the same request.
 * A separate range from the record reads.
 */
function reqIdFor(seq: number): number {
	return pwaWalletSyncReqIdFor(seq)
}

/**
 * Sends one pwaWalletSync request and maps the reply. Never throws.
 *the phrase is sent in its canonical form (the SDK rule, mnemonicCanonical.ts). Before anything is sent, the canonical
 * phrase must derive (mnemonicEoa: word list and checksum, ethers) to the EOA the request carries; otherwise the answer is bad_request and
 * nothing is sent. A phrase the SDK rejects is therefore never sent, and a phrase the SDK accepts is sent with the EOA it derives to.
 */
export async function sendPwaWalletSync(command: string, seq: number, phrase: string, eoa: string): Promise<PwaSyncReply> {
	const e = eoa.trim().toLowerCase()
	const canon = canonicalPhrase(phrase)
	if (!Number.isInteger(seq) || seq <= 0 || !EOA_RE.test(e) || !PHRASE_RE.test(canon)) return { code: 'bad_request' }
	// Two different failures, reported differently. Derivation failed (the word list, the checksum, a thrown error, or no derivation at all
	// in this realm): unknown and retryable, nothing sent, only the reason name is logged (never the words or an address).
	// Derivation gave a different address from the request: bad_request, nothing sent.
	let derived = ''
	try {
		derived = mnemonicEoa(canon)
	} catch {
		derived = ''
	}
	if (derived === '') {
		publishNativePwaLog('warn', '[pwaWalletSync] canonical_derive_failed: not sent, retryable')
		return { code: 'no_answer' }
	}
	if (derived !== e) return { code: 'bad_request' }
	const cmd = { type: command, reqId: reqIdFor(seq), eoa: e, phrase: canon, seq }
	let answer
	try {
		answer = await sendShellWalletSyncCommand(cmd)
	} catch {
		return { code: 'no_answer' }
	}
	if (answer.kind === 'origin_refused') return { code: 'untrusted_source' }
	if (answer.kind !== 'payload') return { code: 'no_answer' }
	return mapSyncReply(answer.payload)
}

/** The reply mapping, exported for the fixtures. */
export function mapSyncReply(payload: Record<string, unknown>): PwaSyncReply {
	if (payload.ok === true) {
		const result = payload.result
		const sync = isPlain(result) ? result.sync : undefined
		return typeof sync === 'string' && SYNC_RESULTS.has(sync) ? { code: 'ok' } : { code: 'no_answer' }
	}
	if (payload.ok !== false) return { code: 'no_answer' }
	const error = typeof payload.error === 'string' ? payload.error : ''
	if (!ERROR_CODES.has(error)) return { code: 'no_answer' }
	if (error === 'write_failed') {
		const reason = typeof payload.reason === 'string' && WRITE_FAILED_REASONS.has(payload.reason) ? payload.reason : 'internal_state'
		return { code: 'write_failed', reason: reason as 'internal_state' | 'storage_write' | 'rollback_pending' | 'old_copy_unverified' }
	}
	return { code: error as ShellSyncAnswer }
}

/** nativeMnemonicPreread: valid | absent | unknown. Anything that is not one of them is unknown (never a value). */
export async function sendNativeMnemonicPreread(seq: number): Promise<PrereadState> {
	if (!Number.isInteger(seq) || seq <= 0) return 'unknown'
	let answer
	try {
		answer = await sendShellWalletSyncCommand({ type: 'nativeMnemonicPreread', reqId: prereadReqIdFor(seq), seq })
	} catch {
		return 'unknown'
	}
	if (answer.kind !== 'payload' || answer.payload.ok !== true) return 'unknown'
	const result = answer.payload.result
	const state = isPlain(result) ? result.state : undefined
	return state === 'valid' || state === 'absent' || state === 'unknown' ? state : 'unknown'
}
