/**
 * The account's own chat PGP public material (keyID and public armor; never a private key). : in the shell it comes
 * from `identityPublic` (spec) and the record's chatManager.pgpKey is not read there at all. The
 * browser keeps its own record (the browser holds the material in its store; there is no native side).
 */
import { readNativeIdentityPublic, shellOwnPgpPublicCached } from './nativeIdentityPublic'
import { isShellContext } from './shellContext'

export type OwnPgpPublic = { keyID: string; publicArmor: string }

/** Only the browser reads this shape from a record; the shell never touches it. */
export type OwnPgpRecordProfile = { chatManager?: { pgpKey?: { keyID?: string; publicKey?: string } } } | null | undefined

const EMPTY: OwnPgpPublic = { keyID: '', publicArmor: '' }

/** Async: shell via identityPublic (EMPTY when not ready or unavailable); browser via the record. */
export async function loadOwnPgpPublicMaterial(profile?: OwnPgpRecordProfile, timeoutMs?: number): Promise<OwnPgpPublic> {
	if (isShellContext()) {
		const r = await readNativeIdentityPublic(timeoutMs)
		if (r.kind === 'ok' && r.pgpReady && r.pgpKeyID && r.pgpPublicKeyArmored) {
			return { keyID: r.pgpKeyID, publicArmor: r.pgpPublicKeyArmored }
		}
		return EMPTY
	}
	const pgp = profile?.chatManager?.pgpKey
	return { keyID: pgp?.keyID ?? '', publicArmor: pgp?.publicKey ?? '' }
}

/**
 * Shell, for a server request: the PGP public material only when identityPublic is ready (ok with a PGP key).
 * One attempt with a 3-second timeout: a request that is not ready is queued (pendingServerSync) and re-sent later.
 * The server writes these fields as given, and a missing field becomes '' (beamioServer.js addUser), so an empty or omitted
 * value would clear the account's PGP key. Returns null when not ready after a few attempts: the caller defers the request.
 */
export async function shellPgpForServerRequest(attempts = 1, delayMs = 0, timeoutMs = 3000): Promise<OwnPgpPublic | null> {
	for (let i = 0; i < attempts; i++) {
		const own = await loadOwnPgpPublicMaterial(undefined, timeoutMs)
		if (own.keyID && own.publicArmor) return own
		if (i < attempts - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
	}
	return null
}

/** Sync: shell gives the last identityPublic answer (EMPTY until one succeeded); browser gives the record. */
export function cachedOwnPgpPublic(profile?: OwnPgpRecordProfile): OwnPgpPublic {
	if (isShellContext()) return shellOwnPgpPublicCached()
	const pgp = profile?.chatManager?.pgpKey
	return { keyID: pgp?.keyID ?? '', publicArmor: pgp?.publicKey ?? '' }
}
