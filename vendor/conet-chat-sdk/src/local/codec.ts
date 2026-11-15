/**
 * Byte-level helpers for the local chat store.
 * Pure WebCrypto + TextEncoder; no network, no WebSocket.
 */

import type { SealedStore } from './types.js'

const enc = new TextEncoder()

export const FIELD_SEP = 0x1f
export const SEP_BYTE = 0x1f

export function subtleCrypto(): SubtleCrypto {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c?.subtle) throw new Error('SubtleCrypto unavailable in this runtime')
	return c.subtle
}

function view(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function utf8(text: string): Uint8Array {
	return enc.encode(text)
}

/** Join string fields with the 0x1f separator used by AAD and HMAC inputs. */
export function joinFields(...parts: Array<string | number>): Uint8Array {
	const pieces = parts.map((p) => enc.encode(String(p)))
	const total = pieces.reduce((n, p) => n + p.length, 0) + Math.max(0, pieces.length - 1)
	const out = new Uint8Array(total)
	let off = 0
	pieces.forEach((p, i) => {
		if (i > 0) out[off++] = FIELD_SEP
		out.set(p, off)
		off += p.length
	})
	return out
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtleCrypto().digest('SHA-256', view(data)))
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	return toHex(await sha256(data))
}

export function toHex(bytes: Uint8Array): string {
	let s = ''
	for (const b of bytes) s += b.toString(16).padStart(2, '0')
	return s
}

export function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
	return out
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function base64url(bytes: Uint8Array): string {
	let out = ''
	let i = 0
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
		out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63]
	}
	const rest = bytes.length - i
	if (rest === 1) {
		const n = bytes[i] << 16
		out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63]
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
		out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63]
	}
	return out
}

export function fromBase64url(s: string): Uint8Array {
	const std = s.replace(/-/g, '+').replace(/_/g, '/')
	const padded = std + '='.repeat((4 - (std.length % 4)) % 4)
	const bin = atob(padded)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

export async function hmacSha256(keyRaw: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const key = await subtleCrypto().importKey('raw', view(keyRaw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return new Uint8Array(await subtleCrypto().sign('HMAC', key, view(data)))
}

/**
 * Compare two strings by UTF-8 byte order (spec: stable_id compared as UTF-8 bytes).
 * Iterates code points so the result matches byte order without allocating.
 */
export function compareUtf8(a: string, b: string): number {
	const la = a.length
	const lb = b.length
	let i = 0
	let j = 0
	while (i < la && j < lb) {
		const ca = a.codePointAt(i) as number
		const cb = b.codePointAt(j) as number
		if (ca !== cb) return ca < cb ? -1 : 1
		i += ca > 0xffff ? 2 : 1
		j += cb > 0xffff ? 2 : 1
	}
	if (i < la) return 1
	if (j < lb) return -1
	return 0
}

/** Sort key K(m) = (sort_ts, stable_id). */
export function compareKey(aTs: number, aId: string, bTs: number, bId: string): number {
	if (aTs !== bTs) return aTs < bTs ? -1 : 1
	return compareUtf8(aId, bId)
}

/** AES-256-GCM sealed store. The only implementation; there is no plaintext path. */
export class AesKey implements SealedStore {
	private constructor(readonly key: CryptoKey) {}

	static async importRaw(raw: Uint8Array): Promise<AesKey> {
		const key = await subtleCrypto().importKey('raw', view(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
		return new AesKey(key)
	}

	/** SealedStore.seal(aad, plaintext): nonce(12) || ciphertext||tag. AAD binds convKey, stable_id, revision. */
	async seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
		const iv = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(12))
		const ct = new Uint8Array(
			await subtleCrypto().encrypt({ name: 'AES-GCM', iv: view(iv), additionalData: view(aad) }, this.key, view(plaintext)),
		)
		const out = new Uint8Array(12 + ct.length)
		out.set(iv, 0)
		out.set(ct, 12)
		return out
	}

	/** SealedStore.open(aad, sealed). */
	async open(aad: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
		const iv = blob.subarray(0, 12)
		const ct = blob.subarray(12)
		const pt = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: view(iv), additionalData: view(aad) }, this.key, view(ct))
		return new Uint8Array(pt)
	}
}

export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Random UUID format used by old iOS and Android sendIds. */
export function isUuid(s: string): boolean {
	return UUID_RE.test(s)
}

/** Overwrite key material before releasing it. */
export function zeroize(bytes: Uint8Array): void {
	bytes.fill(0)
}
