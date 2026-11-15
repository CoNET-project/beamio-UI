/**
 * PWA wallet field wrapping (KAT: passcode-vectors.v1.json `kdf`).
 *
 * Each secret field is replaced in place by a wrap record {v, mode, eoa, kdf, salt, iv, ct}:
 *   - mode "passcode": WK = PBKDF2-HMAC-SHA256(passcode, salt, 600000, 32 bytes) → AES-GCM-256 (non-extractable).
 *   - mode "device":   WK = non-extractable AES-GCM-256 key kept in IndexedDB (no user secret).
 * AAD = "beamio-pwa-wallet-v2|<eoa lowercase>|<field>": a record cannot be moved to another account or field.
 *
 * Honest limit: the device key is reachable by same-origin script; it stops direct reads of stored files.
 * Nothing in this module logs a value.
 */

export class VaultError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'VaultError'
	}
}

export const RECORD_VERSION = 1
export const KDF_TAG = 'PBKDF2-HMAC-SHA256/600000/32'
export const PBKDF2_ITERATIONS = 600000
export const SALT_BYTES = 16
export const IV_BYTES = 12
const AAD_PREFIX = 'beamio-pwa-wallet-v2'

export type WrapMode = 'passcode' | 'device'

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

/** PBKDF2-HMAC-SHA256 output bytes. Used by the KAT and by passcodeWrapKey. The caller zeroes the result. */
export async function pbkdf2Bits(passcode: string, salt: Uint8Array): Promise<Uint8Array> {
	const base = await subtle().importKey('raw', utf8(passcode), 'PBKDF2', false, ['deriveBits'])
	const bits = await subtle().deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
		base,
		256,
	)
	return new Uint8Array(bits)
}

/** WK for passcode mode: non-extractable AES-GCM-256 key. The raw bits are zeroed after import. */
export async function passcodeWrapKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
	const bits = await pbkdf2Bits(passcode, salt)
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

/** Wraps one field value. `salt` is required for passcode mode (the salt that produced `key`). */
export async function wrapField(
	key: CryptoKey,
	plain: string,
	field: string,
	eoa: string,
	mode: WrapMode,
	salt?: Uint8Array,
): Promise<WrapRecord> {
	if (mode === 'passcode' && !salt) throw new VaultError('salt_missing')
	const { iv, ct } = await aesSeal(key, utf8(plain), wrapAad(eoa, field))
	return {
		v: RECORD_VERSION,
		mode,
		eoa: eoa.toLowerCase(),
		kdf: mode === 'passcode' ? KDF_TAG : null,
		salt: mode === 'passcode' && salt ? b64enc(salt) : null,
		iv: b64enc(iv),
		ct: b64enc(ct),
	}
}

export function isWrapRecord(x: unknown): x is WrapRecord {
	const r = x as WrapRecord | null
	return (
		!!r &&
		typeof r === 'object' &&
		r.v === RECORD_VERSION &&
		(r.mode === 'passcode' || r.mode === 'device') &&
		typeof r.ct === 'string' &&
		typeof r.iv === 'string' &&
		typeof r.eoa === 'string'
	)
}

/** Unwraps one field. A wrong key, a moved record or a tampered record all fail with the same code. */
export async function unwrapField(key: CryptoKey, rec: WrapRecord, field: string): Promise<string> {
	const iv = b64dec(rec.iv)
	const ct = b64dec(rec.ct)
	try {
		const plain = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(wrapAad(rec.eoa, field)), tagLength: 128 }, key, ct)
		return utf8Decode(new Uint8Array(plain))
	} catch {
		throw new VaultError('decrypt_failed')
	}
}

// ---------------------------------------------------------------------------
// Device key (non-extractable AES-GCM-256, IndexedDB)
// ---------------------------------------------------------------------------

export interface DeviceKeyStore {
	load(): Promise<CryptoKey | null>
	save(key: CryptoKey): Promise<void>
}

/**
 * Concurrent callers for the same store share one pending load/create, so two start-up readers cannot each create a key
 * (the last save wins; data sealed under the other key would be unreadable, found in the e2e run, 2026-11-11). The share
 * honours the `create` flag (review of 80184e29): a read may join a pending create, but a create never joins a pending
 * read (a read can fail with device_key_missing and would hide the create). A create that finds a pending read waits for
 * that read to settle, then runs its own load-or-create (which still loads an existing key first, so none is replaced).
 */
type PendingDeviceKey = { create: boolean; promise: Promise<CryptoKey> }
const pendingDeviceKeys = new WeakMap<DeviceKeyStore, PendingDeviceKey>()

/** Loads the device key; creates it only when `create` is true (writes). Reads never create a key. */
export function getDeviceKey(store: DeviceKeyStore, create: boolean): Promise<CryptoKey> {
	const pending = pendingDeviceKeys.get(store)
	if (pending) {
		if (pending.create || !create) return pending.promise
		return pending.promise.catch(() => undefined).then(() => getDeviceKey(store, create))
	}
	const run = (async (): Promise<CryptoKey> => {
		const existing = await store.load()
		if (existing) return existing
		if (!create) throw new VaultError('device_key_missing')
		const key = (await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])) as CryptoKey
		await store.save(key)
		const back = await store.load()
		if (!back) throw new VaultError('device_key_missing')
		return back
	})()
	const entry: PendingDeviceKey = {
		create,
		promise: run.finally(() => {
			if (pendingDeviceKeys.get(store) === entry) pendingDeviceKeys.delete(store)
		}),
	}
	pendingDeviceKeys.set(store, entry)
	return entry.promise
}

/**
 * Implementation note (2026-11-11). The device key lives in its own IndexedDB database
 * 'beamio-vault-v1' (store 'keys', id 'device-v1'). Clearing the cache, clearing the local chat library, and the explicit
 * wallet reset do not delete it. Only clearing the site's storage (browser or OS) removes it, and then the wrapped wallet
 * is locked (device key missing) until the wallet is re-imported with the recovery phrase.
 */
const DEVICE_DB = 'beamio-vault-v1'
const DEVICE_STORE = 'keys'
const DEVICE_ID = 'device-v1'

/** IndexedDB device-key store (production). The CryptoKey object is stored; its bytes are never readable from JS. */
let deviceKeyStoreSingleton: DeviceKeyStore | null = null

/** One store object per page, so concurrent callers share the pending load/create (see getDeviceKey). */
export const indexedDbDeviceKeyStore = (): DeviceKeyStore => (deviceKeyStoreSingleton ??= createIndexedDbDeviceKeyStore())

const createIndexedDbDeviceKeyStore = (): DeviceKeyStore => ({
	load: () =>
		new Promise<CryptoKey | null>((resolve, reject) => {
			const open = indexedDB.open(DEVICE_DB, 1)
			open.onupgradeneeded = () => {
				if (!open.result.objectStoreNames.contains(DEVICE_STORE)) open.result.createObjectStore(DEVICE_STORE)
			}
			open.onerror = () => reject(new VaultError('device_store_open'))
			open.onsuccess = () => {
				const db = open.result
				const req = db.transaction(DEVICE_STORE, 'readonly').objectStore(DEVICE_STORE).get(DEVICE_ID)
				req.onsuccess = () => {
					db.close()
					resolve((req.result as CryptoKey | undefined) ?? null)
				}
				req.onerror = () => {
					db.close()
					reject(new VaultError('device_store_read'))
				}
			}
		}),
	save: (key: CryptoKey) =>
		new Promise<void>((resolve, reject) => {
			const open = indexedDB.open(DEVICE_DB, 1)
			open.onupgradeneeded = () => {
				if (!open.result.objectStoreNames.contains(DEVICE_STORE)) open.result.createObjectStore(DEVICE_STORE)
			}
			open.onerror = () => reject(new VaultError('device_store_open'))
			open.onsuccess = () => {
				const db = open.result
				// A synchronous throw here (for example DataCloneError from put) never reaches tx.onerror: the Promise must
				// still settle, or the page waits forever (ACCT-NE defect register, walletWrap put hang).
				let tx: IDBTransaction
				try {
					tx = db.transaction(DEVICE_STORE, 'readwrite')
					tx.objectStore(DEVICE_STORE).put(key, DEVICE_ID)
				} catch {
					db.close()
					reject(new VaultError('device_store_write'))
					return
				}
				tx.oncomplete = () => {
					db.close()
					resolve()
				}
				tx.onerror = () => {
					db.close()
					reject(new VaultError('device_store_write'))
				}
			}
		}),
})
