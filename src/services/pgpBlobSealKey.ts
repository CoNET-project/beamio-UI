/**
 * Sealing key for the chat PGP backup, held as a non-extractable CryptoKey that can only encrypt.
 *
 * The key is the one the current write format uses: AES-256-GCM under SHA-256 of the account key string (the legacy layout that
 * `sealLegacyPgpBlob` writes and `openLegacyPgpBlob` reads). Nothing about the format changes. The CryptoKey can be handed to a worker
 * by structured clone; the worker can encrypt with it but cannot export it or decrypt with it. The account key string is used only
 * here, to derive the key bytes, and the bytes are not kept.
 */

const utf8 = (s: string): Uint8Array => {
	const bin = unescape(encodeURIComponent(s))
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

const toB64 = (u8: Uint8Array): string => {
	let bin = ''
	for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
	return btoa(bin)
}

/** The encrypt-only, non-extractable AES-GCM key of one account, for the legacy backup layout. */
export async function legacySealCryptoKey(accountKeyString: string): Promise<CryptoKey> {
	const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(accountKeyString) as BufferSource))
	return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt'])
}

/** Seals with the given key in the legacy layout: base64(IV[12] || ciphertext). Same output as sealLegacyPgpBlob. */
export async function sealLegacyWithCryptoKey(plaintext: string, key: CryptoKey): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(plaintext) as BufferSource))
	const raw = new Uint8Array(12 + ct.length)
	raw.set(iv, 0)
	raw.set(ct, 12)
	return toB64(raw)
}

/**
 * A sealing session: holds the key while the account session lives. `close` drops the reference, after which nothing can be sealed.
 */
export class PgpSealSession {
	private key: CryptoKey | null

	constructor(key: CryptoKey) {
		this.key = key
	}

	async seal(plaintext: string): Promise<string> {
		if (!this.key) throw new Error('pgp-seal: session closed')
		return sealLegacyWithCryptoKey(plaintext, this.key)
	}

	close(): void {
		this.key = null
	}
}
