/**
 * r94: the page side of `pwaWalletSync` and `nativeMnemonicPreread` (spec §十一, the decided contract v3.2).
 *
 * Request: {type:"pwaWalletSync", reqId, eoa, phrase, seq}. `trustedOrigin` is set by the shell, never by the page.
 * The mnemonic is sent only as `phrase`, never logged. A retry of the same transaction reuses its reqId and seq.
 *
 * Reply (the flat envelope {type:"ack", reqId, ok, result? | error?, reason?}):
 *   ok:true  result.sync = updated | idempotent          → ok
 *   ok:false error = untrusted_source | key_over_bridge_refused | bad_request | stale_seq   → that code
 *   ok:false error = write_failed, reason = internal_state | storage_write                   → write_failed (+reason)
 *   anything else, a malformed ok, a timeout, no channel → no_answer (the page's own unknown: retryable)
 * A refused page origin is untrusted_source (not retried). There is no wire "unknown" answer.
 * `reason` sits beside `error` (the spec's draft placement; §25.52 第 1(a) is read as the same level, to be confirmed).
 */
import { sendShellWalletSyncCommand, shellRecordTransportKind } from './shellRecordTransport'
import type { ShellSyncAnswer } from './shellMnemonicSync'
import { canonicalPhrase } from './mnemonicCanonical'
import { mnemonicEoa } from './shellLegacyIdbInit'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { prereadReqIdFor, pwaWalletSyncReqIdFor } from './reqIdSpaces'
import { isMnemonicCipherEnvelope } from './pageMnemonicField'

const ERROR_CODES: ReadonlySet<string> = new Set(['untrusted_source', 'key_over_bridge_refused', 'bad_request', 'stale_seq', 'write_failed', 'locked'])
// `unchanged` (M6 v3.2): the native record of this account is a protected v3 set and the plaintext request was refused as a downgrade. It is a handled
// answer (the native side keeps the protected record), not a missing one: never retried as no_answer.
const SYNC_RESULTS: ReadonlySet<string> = new Set(['updated', 'idempotent', 'unchanged'])
const WRITE_FAILED_REASONS: ReadonlySet<string> = new Set(['internal_state', 'storage_write', 'rollback_pending', 'old_copy_unverified'])
const EOA_RE = /^0x[0-9a-f]{40}$/
const PHRASE_RE = /^[a-z]+( [a-z]+)*$/

/** The reply as the page reads it. `reason` is set for write_failed only. */
export type PwaSyncReply = { code: ShellSyncAnswer; reason?: 'internal_state' | 'storage_write' | 'rollback_pending' | 'old_copy_unverified' }

/** The native preread answer (spec §十一, nativeMnemonicPreread). */
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
 * r95 (IFF-W): the phrase is sent in its canonical form (the SDK rule, mnemonicCanonical.ts). Before anything is sent, the canonical
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

/**
 * The v3 mnemonic envelope as f3 stores it in the record's `mnemonicPhrase` field (walletVault: sealMnemonicV3WithKey, decision).
 * A structural check only: nothing is decrypted, nothing is logged.
 */
export { isMnemonicCipherEnvelope } from './pageMnemonicField'

/**
 * pwaWalletSync with the v3 cipher (spec §29 section 6, 2026-11-22): {type, reqId, seq, cipher} and, only when a passcode is
 * given, passcode. The shell sets trustedOrigin. The background sync sends no passcode: the cipher is sent exactly as stored. Completion is the
 * shell's read-back confirmation (ok); anything else is not a completed sync.
 */
export async function sendPwaWalletSyncCipher(command: string, seq: number, cipher: unknown, passcode?: string): Promise<PwaSyncReply> {
	if (!Number.isInteger(seq) || seq <= 0 || !isMnemonicCipherEnvelope(cipher)) return { code: 'bad_request' }
	const cmd: Record<string, unknown> = { type: command, reqId: reqIdFor(seq), seq, cipher }
	if (passcode !== undefined) cmd.passcode = passcode
	let answer
	try {
		answer = await sendShellWalletSyncCommand(cmd as never)
	} catch {
		return { code: 'no_answer' }
	}
	if (answer.kind === 'origin_refused') return { code: 'untrusted_source' }
	if (answer.kind !== 'payload') return { code: 'no_answer' }
	return mapCipherSyncReply(answer.payload, passcode !== undefined)
}

/**
 * The cipher reply (spec §30.1, confirmed 2026-11-22): completed only when ok carries stored:true, readback:"match", and decrypted
 * equal to whether a passcode was sent. unlock_failed and verify_failed (passcode branch, 30.3) are closed codes: nothing was written.
 * Every other reply is not a completed sync. The write_failed position (result.code or the envelope error) is not decided here: both
 * placements are not a completion, and the mapping of the envelope error stays as mapSyncReply has it (spec 30.4, pending v286/v291).
 */
export function mapCipherSyncReply(payload: Record<string, unknown>, withPasscode: boolean): PwaSyncReply {
	if (payload.ok === true) {
		const r = payload.result
		// The SDKs answer a wrong passcode and an identity check failure as ok:true with result.code (answerShapes of the M6 vectors): the closed codes.
		if (isPlain(r) && (r.code === 'unlock_failed' || r.code === 'verify_failed')) return { code: r.code }
		const done = isPlain(r) && r.code === 'ok' && r.stored === true && r.readback === 'match' && r.decrypted === withPasscode
		return done ? { code: 'ok' } : { code: 'no_answer' }
	}
	if (payload.ok !== false) return { code: 'no_answer' }
	const error = typeof payload.error === 'string' ? payload.error : ''
	if (error === 'unlock_failed' || error === 'verify_failed') return { code: error }
	return mapSyncReply(payload)
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
	// result.code only ( closed set; 2026-11-22 item 3): ok + mnemonic is the plaintext current (valid);
	// confirmed_missing is the only absence. A ciphertext answer is not a plaintext valid here: it is unknown in this helper.
	const result = answer.payload.result
	if (!isPlain(result)) return 'unknown'
	if (result.code === 'confirmed_missing') return 'absent'
	if (result.code === 'ok' && typeof result.mnemonic === 'string') return 'valid'
	return 'unknown'
}
