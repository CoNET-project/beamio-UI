/**
 * Per-call temporary PGP key for one voice channel user side (v89 §96, v96 §103.4; decision).
 *
 * Generated with a CSPRNG (openpgp) on the device, held in memory only, never reused across calls, and
 * forgotten (cleared) when the call ends. It is never the long-term chat PGP key, and it never falls back to it.
 */
import { generateKey, readKey } from 'openpgp'

export type TemporaryPgpKey = {
	/** Public key armor, sent to the peer inside the authorized offer/accept. */
	publicArmor: string
	/** Private key armor; stays on this device and is cleared when the call ends. */
	privateArmor: string
	/** Primary key fingerprint, lower-case hex (the value bound by voice_pgp_auth_v1 `tempPgpFpr`). */
	fingerprint: string
}

/** A new temporary PGP key pair for one call. No passphrase; the key is not persisted by this function. */
export async function newTemporaryPgpKey(): Promise<TemporaryPgpKey> {
	const { privateKey, publicKey } = await generateKey({
		type: 'ecc',
		curve: 'curve25519',
		passphrase: '',
		userIDs: [{ name: 'voice-temp' }],
		format: 'armored',
	} as never)
	const publicArmor = publicKey as unknown as string
	const keyObj = await readKey({ armoredKey: publicArmor })
	return {
		publicArmor,
		privateArmor: privateKey as unknown as string,
		fingerprint: keyObj.getFingerprint().toLowerCase(),
	}
}

/**
 * Drops the private armor reference held on this record. It does NOT claim the memory is wiped: JavaScript strings are
 * immutable and the key may have copies elsewhere (the worker, GC, the openpgp object). The call-end path must call this
 * and the caller must drop its references; the verifiable part is that the reference is gone from the record.
 */
export function forgetTemporaryPgpKey(key: { privateArmor: string }): void {
	key.privateArmor = ''
}

/**
 * Binding check (v100 §107.4, case K): the fingerprint computed from the peer's `tempPgpArmor` must equal the `tempPgpFpr`
 * signed in the authorization, character for character. Anything else is refused.
 */
export async function tempPgpArmorMatchesFingerprint(publicArmor: string | undefined, signedFpr: string): Promise<boolean> {
	if (!publicArmor) return signedFpr === ''
	if (!/^[0-9a-f]{40}$/.test(signedFpr)) return false
	try {
		return (await fingerprintOfPublicArmor(publicArmor)) === signedFpr
	} catch {
		return false
	}
}

/** The fingerprint of an armored public key, lower-case hex (for checking `tempPgpFpr` against the attached armor). */
export async function fingerprintOfPublicArmor(publicArmor: string): Promise<string> {
	const keyObj = await readKey({ armoredKey: publicArmor })
	return keyObj.getFingerprint().toLowerCase()
}
