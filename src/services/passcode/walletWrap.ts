/**
 * PWA wallet field wrapping (unit f3, 2026-11-22; spec §29 sections 2 and 4).
 *
 * Each secret field is replaced in place by a wrap record {v, mode, eoa, kdf, salt, iv, ct}, mode "passcode" only:
 *   - WK = Argon2id(passcode, salt; m = 32768 KiB, t = 3, p = 1, 32 bytes) -> AES-GCM-256 (non-extractable).
 *   - Salt: 16 random bytes per record; IV: 12 random bytes per seal. The key is never stored with the record.
 * AAD = "beamio-pwa-wallet-v3|<eoa lowercase>|<field>": a record cannot be moved to another account or field.
 *
 * Removed (2026-11-22): the PBKDF2 passcode format, the device-key mode, and the IndexedDB device-key store.
 * Records of the old formats (v=1, or no v with a PBKDF2 kdf, or mode "device") are refused by isLegacyWrapRecord and are
 * never decrypted or rewritten (they are reported as verify_failed by the caller).
 *
 * Nothing in this module logs a value.
 */

export class VaultError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'VaultError'
	}
}

export const RECORD_VERSION = 3
export const KDF_TAG = 'argon2id-aes256gcm/m32768/t3/p1'
export const ARGON2_M_KIB = 32768
export const ARGON2_T = 3
export const ARGON2_P = 1
export const SALT_BYTES = 16
export const IV_BYTES = 12
const AAD_PREFIX = 'beamio-pwa-wallet-v3'

export type WrapMode = 'passcode'

export interface WrapRecord {
	v: number
	mode: WrapMode
	eoa: string
	kdf: string | null
	/** base64 of the 16-byte salt (passcode mode) or null (device mode) */
	salt: string | null
	/** base64 of the 12-byte IV */
	iv: string
	/** base64 of the AES-GCM ciphertext with its 16-byte tag */
	ct: string
}

const subtle = (): SubtleCrypto => {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c?.subtle) throw new VaultError('no_webcrypto')
	return c.subtle
}

export const randomBytes = (n: number): Uint8Array => {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c?.getRandomValues) throw new VaultError('no_webcrypto')
	const out = new Uint8Array(n)
	c.getRandomValues(out)
	return out
}

export const b64enc = (bytes: Uint8Array): string => {
	let bin = ''
	for (const x of bytes) bin += String.fromCharCode(x)
	return btoa(bin)
}

export const b64dec = (s: string): Uint8Array => {
	const bin = atob(s)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

/** UTF-8 without TextEncoder (absent in some test environments). */
export const utf8 = (s: string): Uint8Array => {
	if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s)
	const bin = unescape(encodeURIComponent(s))
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

export const utf8Decode = (b: Uint8Array): string => {
	if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(b)
	let bin = ''
	for (const x of b) bin += String.fromCharCode(x)
	return decodeURIComponent(escape(bin))
}

export const wrapAad = (eoa: string, field: string): string => `${AAD_PREFIX}|${eoa.toLowerCase()}|${field}`

/** Argon2id derivation shape (the worker bridge's argon2idAsync). */
export type PasscodeKdf = (password: Uint8Array, salt: Uint8Array, opts: { m: number; t: number; p: number; dkLen: number }) => Promise<Uint8Array>

let injectedKdf: PasscodeKdf | null = null

/**
 * Test injection point only (unit f3). Production never calls this: without it, the derivation goes through the worker bridge
 * (argon2WorkerBridge.argon2idAsync, loaded dynamically). Jest cannot load the bridge module (its import.meta), so tests inject.
 */
export function setPasscodeKdfForTest(f: PasscodeKdf | null): void {
	injectedKdf = f
}

/** Argon2id output bytes (m 32 MiB, t 3, p 1, 32 bytes) through the worker bridge in production. The caller zeroes the result. */
export async function argon2Bits(passcode: string, salt: Uint8Array): Promise<Uint8Array> {
	const kdf = injectedKdf ?? (await import('../argon2WorkerBridge')).argon2idAsync
	return kdf(utf8(passcode), salt, { m: ARGON2_M_KIB, t: ARGON2_T, p: ARGON2_P, dkLen: 32 })
}

/** WK for passcode mode: non-extractable AES-GCM-256 key. The raw bits are zeroed after import. */
export async function passcodeWrapKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
	const bits = await argon2Bits(passcode, salt)
	try {
		return await subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
	} finally {
		bits.fill(0)
	}
}

export const newSalt = (): Uint8Array => randomBytes(SALT_BYTES)

async function aesSeal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
	const iv = randomBytes(IV_BYTES)
	const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, plain))
	return { iv, ct }
}

/** Wraps one field value under the passcode key. `salt` is required (the salt that produced `key`). */
export async function wrapField(
	key: CryptoKey,
	plain: string,
	field: string,
	eoa: string,
	salt: Uint8Array,
): Promise<WrapRecord> {
	const { iv, ct } = await aesSeal(key, utf8(plain), wrapAad(eoa, field))
	return {
		v: RECORD_VERSION,
		mode: 'passcode',
		eoa: eoa.toLowerCase(),
		kdf: KDF_TAG,
		salt: b64enc(salt),
		iv: b64enc(iv),
		ct: b64enc(ct),
	}
}

/**
 * Records of the removed formats (v=1; or no v with a PBKDF2 kdf; or mode "device"). They are refused, never decrypted and never
 * rewritten: the caller reports them as verify_failed and keeps the bytes.
 */
export function isLegacyWrapRecord(x: unknown): boolean {
	const r = x as Record<string, unknown> | null
	if (!r || typeof r !== 'object') return false
	if (r.mode === 'device') return true
	if (r.v === 1) return true
	return (r.v === undefined || r.v === null) && typeof r.kdf === 'string' && r.kdf.startsWith('PBKDF2')
}

export function isWrapRecord(x: unknown): x is WrapRecord {
	const r = x as WrapRecord | null
	return (
		!!r &&
		typeof r === 'object' &&
		r.v === RECORD_VERSION &&
		r.mode === 'passcode' &&
		typeof r.salt === 'string' &&
		typeof r.ct === 'string' &&
		typeof r.iv === 'string' &&
		typeof r.eoa === 'string'
	)
}

/**
 * Unwraps one field. The AAD binds the field name and the account the slot belongs to (`eoa`, lower case). A record moved to
 * another field or another account fails the same way as a wrong key or a tampered record (decrypt_failed).
 */
export async function unwrapField(key: CryptoKey, rec: WrapRecord, field: string, eoa: string = rec.eoa): Promise<string> {
	const iv = b64dec(rec.iv)
	const ct = b64dec(rec.ct)
	try {
		const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(wrapAad(eoa, field)), tagLength: 128 }, key, ct)
		return utf8Decode(new Uint8Array(plain))
	} catch {
		throw new VaultError('decrypt_failed')
	}
}
