/**
 * PGP private-key blob ciphers (禁止 2).
 *
 * Two formats live on the AddressPGP record (`encrypKeyArmored`, read by `getEncryptedPrivateKey()`):
 *   - legacy: base64(IV[12] || AES-GCM ciphertext) with the key SHA-256(password), where the password is the account
 *     private-key string. The account key is the key material. Read only once, to migrate (wallet module).
 *   - v2: "BPK2:" + base64(IV[12] || AES-GCM ciphertext) with the sub-key DEK-local, derived from R_db by walletCore.
 *     The account key is never used as cipher key material for this blob.
 *
 * This file is pure: it receives keys as bytes or strings from its caller and returns blobs or plaintext. It never
 * logs. The caller (walletCore) decides which key is passed in. Text is UTF-8 with no TextEncoder dependency.
 */

export const PGP_BLOB_V2_PREFIX = 'BPK2:'

/**
 * Rollout gate for WRITING the v2 blob to the chain; the rollout is left to the release decision.
 * A client that cannot open v2 treats an unreadable blob as "no key" and creates a new PGP key, which would overwrite the
 * user's key on chain (see chat.ts initBeamioPGPKeys). So v2 is written only after every client that reads this account
 * can open v2. Until then new writes keep the legacy layout, sealed inside walletCore. Reads of v2 are always enabled.
 */
export const PGP_BLOB_V2_WRITES_ENABLED = false

/** Fixed message layout the registration endpoint verifies (x402sdk `chatRouteAuth.ts`). Do not change without the server. */
export const buildRegiestChatRouteMessage = (p: {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	timestamp: number
	nonce: string
	keccak: (s: string) => string
}): string => [
	'Beamio regiestChatRoute',
	`wallet:${p.wallet.toLowerCase()}`,
	`keyID:${p.keyID}`,
	`publicKeyArmoredHash:${p.keccak(p.publicKeyArmored)}`,
	`encrypKeyArmoredHash:${p.keccak(p.encrypKeyArmored)}`,
	`routeKeyID:${p.routeKeyID}`,
	`timestamp:${p.timestamp}`,
	`nonce:${p.nonce.toLowerCase()}`,
].join('\n')

export function isPgpBlobV2(blob: unknown): blob is string {
	return typeof blob === 'string' && blob.startsWith(PGP_BLOB_V2_PREFIX)
}

const utf8 = (s: string): Uint8Array => {
	const bin = unescape(encodeURIComponent(s))
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

const fromUtf8 = (bytes: ArrayBuffer | Uint8Array): string => {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	let bin = ''
	for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
	return decodeURIComponent(escape(bin))
}

const toB64 = (u8: Uint8Array): string => {
	let bin = ''
	for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
	return btoa(bin)
}

/**
 * Strict base64 for the backup text (the backup-text rule, step 4): the standard
 * alphabet, padding present, no whitespace or line breaks, and canonical trailing bits. Anything else throws, so a backup
 * the strict reader cannot take is undecryptable; it is never decoded leniently (the old atob ignored whitespace).
 */
const STRICT_B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export function fromStrictBase64(s: string): Uint8Array {
	if (typeof s !== 'string' || s.length === 0 || !STRICT_B64_RE.test(s)) throw new Error('pgp-blob: strict base64')
	const bin = atob(s)
	if (btoa(bin) !== s) throw new Error('pgp-blob: strict base64')
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

const importAes = (raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> =>
	crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage])

/** v2 seal: AES-256-GCM under the 32-byte sub-key, random 96-bit IV. Returns "BPK2:" + base64(IV || ct). */
export async function sealPgpBlobV2(plaintext: string, dek: Uint8Array): Promise<string> {
	if (dek.length !== 32) throw new Error('pgp-blob: key length')
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const key = await importAes(dek, 'encrypt')
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(plaintext) as BufferSource))
	const raw = new Uint8Array(iv.length + ct.length)
	raw.set(iv, 0)
	raw.set(ct, iv.length)
	return PGP_BLOB_V2_PREFIX + toB64(raw)
}

/** v2 open. Throws when the blob is not v2, is malformed, or the sub-key does not match (GCM tag check). */
export async function openPgpBlobV2(blob: string, dek: Uint8Array): Promise<string> {
	if (!isPgpBlobV2(blob)) throw new Error('pgp-blob: not v2')
	if (dek.length !== 32) throw new Error('pgp-blob: key length')
	const raw = fromStrictBase64(blob.slice(PGP_BLOB_V2_PREFIX.length))
	if (raw.length < 13) throw new Error('pgp-blob: short')
	const key = await importAes(dek, 'decrypt')
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource }, key, raw.slice(12) as BufferSource)
	return fromUtf8(pt)
}

/**
 * Legacy open, exactly as `beamio.ts` aesGcmDecrypt reads it: key = SHA-256(UTF-8 password), IV = first 12 bytes.
 * The password is the account key string, so this is used once, inside the wallet module, to migrate the blob.
 */
export async function openLegacyPgpBlob(blob: string, password: string): Promise<string> {
	const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(password) as BufferSource))
	const raw = fromStrictBase64(blob)
	if (raw.length < 13) throw new Error('pgp-blob: short')
	const key = await importAes(keyBytes, 'decrypt')
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource }, key, raw.slice(12) as BufferSource)
	return fromUtf8(pt)
}

/**
 * Legacy seal, exactly as `beamio.ts` aesGcmEncrypt writes it. Used only while PGP_BLOB_V2_WRITES_ENABLED is false, and
 * by tests. Called from walletCore, which supplies the password.
 */
export async function sealLegacyPgpBlob(plaintext: string, password: string): Promise<string> {
	const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(password) as BufferSource))
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const key = await importAes(keyBytes, 'encrypt')
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(plaintext) as BufferSource))
	const raw = new Uint8Array(12 + ct.length)
	raw.set(iv, 0)
	raw.set(ct, 12)
	return toB64(raw)
}
