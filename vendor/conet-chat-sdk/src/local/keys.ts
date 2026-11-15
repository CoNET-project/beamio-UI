/**
 * Key derivation and identity formulas for the local chat library (-r1).
 * Pure functions: no storage, no network.
 *
 * Decision D17, plan A: the only root of the local library is R_db = HKDF(ikm = private key P, salt
 * "beamio-chat-local-root|salt|v1", info "beamio-chat-local-root|v1|eoa|workspace"). K_id, K_idx, DEK and kcv all come
 * from R_db. R_proto (the EIP-191 keccak) is the protocol root and is not used here. The SDK storage only receives
 * the subkeys (K_id, K_idx, DEK); P and R_db are derived in the wallet layer (condition 2).
 */

import { hkdf } from '../crypto.js'
import { SEP_BYTE, base64url, hmacSha256, joinFields, sha256, toHex, utf8 } from './codec.js'

export interface LocalKeys {
	/** K_id: sendKey derivation. */
	kId: Uint8Array
	/** K_idx: stable_id, conv_blind, cid_blind, layout key blind. */
	kIdx: Uint8Array
	/** DEK: AES-256-GCM key for bodies, metadata and layout values. Zeroize on lock. */
	dek: Uint8Array
	/** kcv = HMAC-SHA256(DEK, "kcv"), hex. Used to check the derived key against the library. */
	kcv: string
}

const enc = (s: string) => utf8(s)

/** Derive K_id, K_idx, DEK and kcv from R_db （方案 A，）. */
export async function deriveLocalKeys(rDb: Uint8Array, eoa: string, workspace: string): Promise<LocalKeys> {
	const kId = await hkdf(rDb, 'chat-local-id-v1', 32)
	const kIdx = await hkdf(rDb, 'chat-local-idx-v1', 32)
	const dek = await hkdf(rDb, `beamio-chat-local-db|v1|${eoa.toLowerCase()}|${workspace}`, 32, enc('beamio-chat-local-db|salt|v1'))
	const kcv = toHex(await hmacSha256(dek, enc('kcv')))
	return { kId, kIdx, dek, kcv }
}

/** kcv for a DEK. The subkeys are the only input the storage layer receives. */
export async function kcvOf(dek: Uint8Array): Promise<string> {
	return toHex(await hmacSha256(dek, enc('kcv')))
}

/** R_db from the private key bytes P. Used by the worker, which already holds P. */
export async function deriveRootDb(privateKey: Uint8Array, eoa: string, workspace: string): Promise<Uint8Array> {
	return hkdf(privateKey, `beamio-chat-local-root|v1|${eoa.toLowerCase()}|${workspace}`, 32, enc('beamio-chat-local-root|salt|v1'))
}

/**
 * sendKey. A non-empty sendId is kept as the sendKey in any format, including UUIDs. Only an empty
 * or missing sendId is derived from the record. The hash input is the raw SHA-256 bytes of the stored body.
 */
export async function sendKeyFromRecord(
	kId: Uint8Array,
	rec: { convKey: string; dir: 'in' | 'out'; sortTs: number; body: string; sendId?: string | null },
): Promise<string> {
	if (rec.sendId) return rec.sendId
	const bodyDigest = await sha256(utf8(rec.body))
	const msg = joinFields(rec.convKey.toLowerCase(), rec.dir, String(rec.sortTs))
	const full = new Uint8Array(msg.length + 1 + bodyDigest.length)
	full.set(msg, 0)
	full[msg.length] = SEP_BYTE
	full.set(bodyDigest, msg.length + 1)
	return 'x' + base64url(await hmacSha256(kId, full))
}

/** stable_id = base64url(HMAC-SHA256(K_idx, UTF8(sendKey))), 43 characters. */
export async function stableIdFromSendKey(kIdx: Uint8Array, sendKey: string): Promise<string> {
	return base64url(await hmacSha256(kIdx, utf8(sendKey)))
}

/** conv_blind(convKey) = base64url(HMAC-SHA256(K_idx, UTF8(convKey))). */
export async function convBlindOf(kIdx: Uint8Array, convKey: string): Promise<string> {
	return base64url(await hmacSha256(kIdx, utf8(convKey)))
}

/** cid_blind(cid) = base64url(HMAC-SHA256(K_idx, UTF8(cid))). */
export async function cidBlindOf(kIdx: Uint8Array, cid: string): Promise<string> {
	return base64url(await hmacSha256(kIdx, utf8(cid)))
}

/** Layout key blind from its params string, e.g. "392|portrait|10|1" (AAD). */
export async function layoutKeyBlindOf(kIdx: Uint8Array, params: string): Promise<string> {
	return base64url(await hmacSha256(kIdx, utf8(params)))
}
