/**
 * The fingerprint a contact's key is compared and verified by (spec.5). It is the OpenPGP standard fingerprint of the
 * public key, as the Chat SDK reads it: lowercase hex, 40 characters for v4 and 64 for v5/v6. It is not a hash of the armor text: the same key
 * can come as armor that differs in line breaks or headers, and the armor hash would then differ.
 */
import { readKey } from 'openpgp'

export async function openPgpFingerprintOfArmor(armor: string): Promise<string> {
	const key = await readKey({ armoredKey: armor.trim() })
	return key.getFingerprint().toLowerCase()
}

/**
 * the OpenPGP fingerprint (lowercase hex) of the key that actually ENCRYPTS to this public key: the encryption subkey that OpenPGP selects (`getEncryptionKey`),
 * or the primary key when it has no encryption subkey. The AddressPGP record's `userPgpKeyID` is the key ID of this subkey (measured on the chain: it is not the
 * primary key's ID), so the first-contact chain trust (chainPgpTrust.ts) compares the record's id with this value, while the pinned/compared fingerprint stays the primary
 * key's (`openPgpFingerprintOfArmor`).
 */
export async function openPgpEncryptionKeyFingerprintOfArmor(armor: string): Promise<string> {
	const key = await readKey({ armoredKey: armor.trim() })
	const enc = await key.getEncryptionKey()
	return enc.getFingerprint().toLowerCase()
}

/** The fingerprint as the user compares it: groups of four characters, in upper case. */
export function formatFingerprintForCompare(fingerprint: string): string {
	return (fingerprint.toUpperCase().match(/.{1,4}/g) ?? []).join(' ')
}

/**
 * The fingerprint as it is stored with the chat copy (`chatData.keyFingerprint`). The value carries its scheme, so a value stored before the
 * OpenPGP fingerprint was used (an armor SHA-256, from a QA build) is never read as a baseline: it has no scheme and is treated as none
 * (an old value compared with an OpenPGP fingerprint always differs).
 */
const STORED_SCHEME = 'openpgp:'

export function storedKeyFingerprint(fingerprint: string): string {
	return `${STORED_SCHEME}${fingerprint.toLowerCase()}`
}

/** The OpenPGP fingerprint of a stored value, or undefined when the value is missing or has no OpenPGP scheme (no baseline). */
export function readStoredKeyFingerprint(stored: string | undefined | null): string | undefined {
	if (!stored || !stored.startsWith(STORED_SCHEME)) return undefined
	const fp = stored.slice(STORED_SCHEME.length).trim()
	return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(fp) ? fp : undefined
}
