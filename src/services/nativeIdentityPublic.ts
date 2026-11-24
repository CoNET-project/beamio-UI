/**
 * Public identity from the native layer. The page reads the public
 * material of the account with `identityPublic` (G2 only, read-only). No key, passphrase, recovery code, mnemonic or backup text
 * ever comes back: the result carries only the EOA, the account key, and the public PGP and route material.
 *
 * Gate: G0 answers `no_key`, G1 answers `not_ready`, G2 answers the result (passcode lock does not matter).
 */
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { NATIVE_QUERY_REQ_BASE } from './nativeKeyState'

export const NATIVE_IDENTITY_PUBLIC_COMMAND = 'identityPublic'
/** a request waits at least 45 s before it is called slow (the slowest observed read was 17 s); slow never resends */
const TIMEOUT_MS = 45_000

/** Field names that must never appear in a result. */
const FORBIDDEN_RESULT_KEYS = [
	'privateKey',
	'privateKeyHex',
	'privateKeyArmor',
	'pgpPrivateKeyArmored',
	'encrypKeyArmored',
	'mnemonic',
	'recoveryCode',
	'pin',
	'password',
	'accountPassword',
	'passcode',
	'hash',
	'img',
	'stored',
	'ciphertext',
	'backupCiphertext',
]

const EOA_RE = /^0x[0-9a-f]{40}$/
const PGP_PUBLIC_ARMOR_HEAD = '-----BEGIN PGP PUBLIC KEY BLOCK-----'

/** A PGP public key armor: starts with the public key block header and carries no private material. */
export function isPgpPublicArmor(value: string): boolean {
	return value.trimStart().startsWith(PGP_PUBLIC_ARMOR_HEAD) && !/PRIVATE/.test(value)
}

export type NativeIdentityPublic =
	| {
			kind: 'ok'
			eoa: string
			accountKey: string
			pgpReady: boolean
			/** false: the native side could not read its PGP vault, so pgpReady:false is unknown (not "no key"). Present only when false. */
			pgpReadyKnown?: false
			/** Present only when pgpReady is true. */
			pgpKeyID?: string
			pgpPublicKeyArmored?: string
			ownRouteArmoredPublicKey?: string
	  }
	| { kind: 'no_key'; kPresent?: boolean }
	/** HC-LOCK (v10 §3.2 identityPublic): the native lock. Not identity missing and not a bad identity; the caller takes the unlock branch. */
	| { kind: 'locked' }
	| { kind: 'not_ready' | 'bad_request' | 'key_over_bridge_refused' | 'unavailable' | 'bad_identity' }

/**: the top-level kPresent of an ok:false no_key answer. Read only when the shell declares identity.kpresent.v1; otherwise absent. */
export const IDENTITY_KPRESENT_CAPABILITY = 'identity.kpresent.v1'
export function kPresentFromNoKeyAnswer(payload: unknown, capabilities: readonly string[]): boolean | undefined {
	if (!capabilities.includes(IDENTITY_KPRESENT_CAPABILITY)) return undefined
	const v = (payload as { kPresent?: unknown } | null)?.kPresent
	return typeof v === 'boolean' ? v : undefined
}

let identityPublicSeq = 0

/** The account's public EOA after a successful read, for code that must not read the profile. Not a key. */
let shellPublicEoa = ''
/** Listeners told when the native public EOA becomes known or changes (the history read of a shell depends on it). */
const publicEoaListeners = new Set<() => void>()
export function onShellPublicEoaChange(cb: () => void): () => void {
	publicEoaListeners.add(cb)
	return () => {
		publicEoaListeners.delete(cb)
	}
}
let shellAccountKey = ''
/** The account's own chat PGP public material from the last successful read (public only). */
let shellPgpKeyID = ''
let shellPgpPublicArmor = ''
export function shellOwnPgpPublicCached(): { keyID: string; publicArmor: string } {
	return { keyID: shellPgpKeyID, publicArmor: shellPgpPublicArmor }
}
export function shellPublicEoaOrEmpty(): string {
	return shellPublicEoa
}
/** The account key (`eoa:workspace`) from the last successful read. Public, not a key; the PGP commands take it. */
export function shellAccountKeyOrEmpty(): string {
	return shellAccountKey
}

const hasForbiddenKey = (value: unknown): boolean => {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasForbiddenKey)
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_RESULT_KEYS.includes(k)) return true
		if (hasForbiddenKey(v)) return true
	}
	return false
}

/** Parses the result. Returns `bad_identity` for any shape or field this page does not accept; never echoes a value. */
export function parseIdentityPublicResult(result: unknown): NativeIdentityPublic {
	if (!result || typeof result !== 'object' || hasForbiddenKey(result)) return { kind: 'bad_identity' }
	const r = result as Record<string, unknown>
	const eoa = typeof r.eoa === 'string' ? r.eoa : ''
	if (!EOA_RE.test(eoa)) return { kind: 'bad_identity' }
	if (typeof r.accountKey !== 'string' || !r.accountKey) return { kind: 'bad_identity' }
	if (typeof r.pgpReady !== 'boolean') return { kind: 'bad_identity' }
	// pgpReady false is not an error and not "no identity": the old layout reads as false, with no PGP fields.
	if (!r.pgpReady) return r.pgpReadyKnown === false ? { kind: 'ok', eoa, accountKey: r.accountKey, pgpReady: false, pgpReadyKnown: false } : { kind: 'ok', eoa, accountKey: r.accountKey, pgpReady: false }
	const pgpKeyID = typeof r.pgpKeyID === 'string' ? r.pgpKeyID : ''
	const pgp = typeof r.pgpPublicKeyArmored === 'string' ? r.pgpPublicKeyArmored : ''
	const route = typeof r.ownRouteArmoredPublicKey === 'string' ? r.ownRouteArmoredPublicKey : ''
	if (!pgpKeyID || !pgp || !route) return { kind: 'bad_identity' }
	// Both keys are PGP public armor, the same format a production save accepts.
	if (!isPgpPublicArmor(pgp) || !isPgpPublicArmor(route)) return { kind: 'bad_identity' }
	return {
		kind: 'ok',
		eoa,
		accountKey: r.accountKey,
		pgpReady: true,
		pgpKeyID,
		pgpPublicKeyArmored: pgp,
		ownRouteArmoredPublicKey: route,
	}
}

/**
 * Reads the public identity of the unlocked account (G2). The command has only `{type, reqId}`. A refusal is returned as its
 * code; an unanswered shell is `unavailable`. On success the EOA is remembered for the shell start (public, not a key).
 */
export async function readNativeIdentityPublic(timeoutMs: number = TIMEOUT_MS): Promise<NativeIdentityPublic> {
	if (typeof window === 'undefined') return { kind: 'unavailable' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { kind: 'unavailable' }
	const capabilities = probe.capabilities
	identityPublicSeq += 1
	const answer = await requestNativeAck({ type: NATIVE_IDENTITY_PUBLIC_COMMAND }, timeoutMs, NATIVE_QUERY_REQ_BASE + identityPublicSeq)
	if (answer.kind !== 'payload') return { kind: 'unavailable' }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown; result?: unknown }
	if (p.type !== 'ack') return { kind: 'bad_identity' }
	if (p.ok === true) {
		const parsed = parseIdentityPublicResult(p.result)
		if (parsed.kind === 'ok') {
			const eoaChanged = shellPublicEoa !== parsed.eoa
			shellPublicEoa = parsed.eoa
			shellAccountKey = parsed.accountKey
			shellPgpKeyID = parsed.pgpReady ? (parsed.pgpKeyID ?? '') : ''
			shellPgpPublicArmor = parsed.pgpReady ? (parsed.pgpPublicKeyArmored ?? '') : ''
			if (eoaChanged) for (const cb of [...publicEoaListeners]) {
				try {
					cb()
				} catch {
					// a listener must not break the read
				}
			}
		}
		return parsed
	}
	switch (p.error) {
		case 'no_key':
			return { kind: 'no_key', kPresent: kPresentFromNoKeyAnswer(p, capabilities) }
		case 'locked':
			return { kind: 'locked' }
		case 'not_ready':
		case 'bad_request':
		case 'key_over_bridge_refused':
			return { kind: p.error }
		default:
			return { kind: 'bad_identity' }
	}
}
