/**
 * Identity payloads for the native side (capability `identity.native-keys.v1`, shared identity vectors).
 *
 * When a shell declares the capability in `hello`, the page sends public material only: the account address, the PGP
 * public armor, the own route public armor and the node list. It never sends a private key, a passphrase or a mnemonic.
 * When the capability is absent, no legacy payload is sent: no key crosses the bridge. The native chat is
 * not started instead, and the caller shows the state. There is no fallback to a payload that carries a key.
 *
 * Pure: no SDK import, no logging. The caller decides the gate from the raw `hello` answer.
 */
import type { ChatDaemonFeatures } from '@conet.project/chat-sdk'

export const NATIVE_KEYS_CAPABILITY = 'identity.native-keys.v1'

/**
 * Keys the page must never send over the bridge (vector file, `forbiddenKeysCaseInsensitive`). Compared after the
 * normalisation below, case-insensitively.
 */
export const IDENTITY_FORBIDDEN_KEYS: readonly string[] = [
	'privateKeyHex',
	'walletPrivateKey',
	'privateKeyArmor',
	'pgpPrivateKeyArmored',
	'pgpPassphrase',
	'mnemonic',
]
/**
 * the CRED names. The identity commands (provisionIdentity, init) refuse all of them, and so
 * does the bridge guard (bridgeGuard.ts). The vector's six names above are a subset. `passphrase`is in the table by.
 */
export const CRED_NAMES: readonly string[] = Array.from(
	new Set([
		...IDENTITY_FORBIDDEN_KEYS,
		'privateKeyArmored',
		'recoveryCode',
		'pin',
		'password',
		'accountPassword',
		'encrypKeyArmored',
		'privateKeyArmor',
		'privateKeyArmorWrap',
		'mnemonicPhrase',
		'recoveryWords',
		'passphrase',
	]),
)
const FORBIDDEN_LOWER: ReadonlySet<string> = new Set(CRED_NAMES.map((k) => k.toLowerCase()))

/**
 * Normalisation N (vector `valueShapeRules` rule 0, notice 30): first Unicode NFKD (decomposition, so a combining mark is
 * separated from its base character; full-width and compatibility characters map to ASCII), then every character of the
 * set S is removed, then every character of the general categories Mn, Me and Cf. Used for detection only: no value and
 * no key is rewritten by it. No platform trim() is used.
 * S = Unicode White_Space (U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
 * U+3000) plus U+FEFF, U+200B–U+200D, U+2060, U+00AD.
 */
const S_CLASS = '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF\\u200B-\\u200D\\u2060\\u00AD'
const NORMALIZE_STRIP = new RegExp(`[${S_CLASS}]`, 'g')
const IN_S_ONE = new RegExp(`[${S_CLASS}]`)
const MARKS_AND_FORMAT = /[\p{Mn}\p{Me}\p{Cf}]/gu
export const normalizeForCompare = (s: string): string =>
	s.normalize('NFKD').replace(NORMALIZE_STRIP, '').replace(MARKS_AND_FORMAT, '')

/** Key whitelist (notice 30): after N only ASCII letters, digits and underscore; the original key must equal N(key). */
const KEY_OK = /^[A-Za-z0-9_]+$/
export const isCanonicalKey = (k: string): boolean => KEY_OK.test(k) && k === normalizeForCompare(k)

/**
 * Value shapes (vector `valueShapeRules`, five rules; the vector text is authoritative):
 *   0. Normalise N (above) before every comparison.
 *   1. A string whose N form contains PRIVATEKEYBLOCK (PRIVATE KEY BLOCK without spaces; compared case-insensitively) is
 *      refused at any depth, nodes included.
 *   2. A string whose N form matches ^(0[xX])?[0-9a-fA-F]{64}$ is refused at any depth. The one exception is the value of
 *      the top-level key `nodes` (exact string, not normalised) and its subtree. payload.identity.nodes, payload.extra.nodes
 *      and other nested nodes keys are not exceptions.
 *   3. A multi-line string is a long string after normalisation and does not match rule 2 (for example a PGP public armor).
 *   4. Forbidden key names are compared after N, case-insensitively, at any depth, nodes included.
 *   5. Order: key names over the whole payload, then PRIVATEKEYBLOCK, then 64 hex. Objects and arrays recurse.
 * A refusal names the field only, never the value.
 */
const HEX64 = /^(0[xX])?[0-9a-fA-F]{64}$/
const PRIVATE_BLOCK = 'PRIVATEKEYBLOCK'
const NODES_KEY = 'nodes'

const hasBlock = (value: string): boolean => normalizeForCompare(value).toUpperCase().includes(PRIVATE_BLOCK)
const isHex64Value = (value: string): boolean => HEX64.test(normalizeForCompare(value))

export interface IdentityPublicSource {
	eoaAddress: string
	pgpPublicKeyArmored?: string
	ownRouteArmoredPublicKey?: string
}

/** The public fields of the accept case (vector `requestCases[accept-public-only].input`). */
export interface PublicIdentityFields {
	eoa: string
	/** Absent until it is known: init and provisionIdentity may omit it on the recovery path. */
	pgpPublicKeyArmored?: string
	/** Absent until it is known: the key is omitted, never sent as an empty string. */
	ownRouteArmoredPublicKey?: string
}

/**
 * The public fields to send. The address goes out in canonical form (lower-case), because the native side refuses any
 * other form (vector: bad_identity for an upper-case or checksummed address). The page converts; it never strips.
 */
export function publicIdentityFields(id: IdentityPublicSource): PublicIdentityFields {
	const out: PublicIdentityFields = {
		eoa: String(id.eoaAddress ?? '').toLowerCase(),
	}
	if (id.ownRouteArmoredPublicKey) out.ownRouteArmoredPublicKey = id.ownRouteArmoredPublicKey
	// Omitted when not known; an empty string is not sent.
	if (id.pgpPublicKeyArmored) out.pgpPublicKeyArmored = id.pgpPublicKeyArmored
	return out
}

/**
 * The capability is declared when the module answered `hello` as negotiated and its raw answer lists the capability.
 * `raw` is the `hello` answer as received (unknown capability names are dropped from `features`, so the raw list is used).
 * A module that did not answer, or answered without the capability, gets no identity payload at all: native chat does not start.
 */
export function nativeKeysDeclared(features: ChatDaemonFeatures | null | undefined, raw: unknown): boolean {
	if (!features || features.status !== 'negotiated') return false
	if (!raw || typeof raw !== 'object') return false
	const caps = (raw as { capabilities?: unknown }).capabilities
	return Array.isArray(caps) && caps.includes(NATIVE_KEYS_CAPABILITY)
}

type Hit = string | null

/** Rule 4 (key names), at any depth, over the whole payload. */
function scanKeys(value: unknown): Hit {
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = scanKeys(item)
			if (hit) return hit
		}
		return null
	}
	if (!value || typeof value !== 'object') return null
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_LOWER.has(normalizeForCompare(key).toLowerCase())) return key
		const hit = scanKeys(child)
		if (hit) return hit
	}
	return null
}

/** Generic walk over every string value. `visit` says whether the string is refused. Returns the field that holds it. */
function walkStrings(
	value: unknown,
	field: string,
	exempt: boolean,
	root: boolean,
	visit: (s: string, exempt: boolean) => boolean,
): Hit {
	if (typeof value === 'string') return visit(value, exempt) ? field || '(value)' : null
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = walkStrings(item, field, exempt, false, visit)
			if (hit) return hit
		}
		return null
	}
	if (!value || typeof value !== 'object') return null
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		// Only the top-level `nodes` key of the payload (exact string) is exempt from rule 2, with its whole subtree.
		const childExempt = exempt || (root && key === NODES_KEY)
		const hit = walkStrings(child, key, childExempt, false, visit)
		if (hit) return hit
	}
	return null
}

/**
 * Deep scan of a whole payload, in the vector's order: key names over the whole payload, then the block marker
 * over the whole payload, then the 64-hex rule over the whole payload. Returns the refused field name, or null. Used as the
 * guard on the capability-branch payloads, and by the tests against the vector file.
 */
export function findForbiddenKey(payload: unknown): string | null {
	const keys = scanKeys(payload)
	if (keys) return keys
	const block = walkStrings(payload, '', false, true, (s) => hasBlock(s))
	if (block) return block
	return walkStrings(payload, '', false, true, (s, exempt) => !exempt && isHex64Value(s))
}

/**
 * Key whitelist, at every depth (nodes included). Runs after the key_over_bridge checks (notice 30). Returns the first key
 * that is not canonical, or null. The message names the key only.
 */
export function findBadKey(payload: unknown): string | null {
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const hit = findBadKey(item)
			if (hit !== null) return hit
		}
		return null
	}
	if (!payload || typeof payload !== 'object') return null
	for (const [key, child] of Object.entries(payload as Record<string, unknown>)) {
		if (!isCanonicalKey(key)) return key
		const hit = findBadKey(child)
		if (hit !== null) return hit
	}
	return null
}

/** Throws when a forbidden key is present. The message names the key only, never its value. */
export function assertNoKeyMaterial(payload: unknown, where: string): void {
	const hit = findForbiddenKey(payload)
	if (hit) throw new Error(`${where}: key material refused (${hit})`)
}

/* ---- canonical public identity (notice 28) ---- */

/** The address must be canonical: unchanged by N, lower-case hex after 0x, 40 digits. Otherwise bad_identity. */
export function isCanonicalEoa(v: unknown): boolean {
	return typeof v === 'string' && v === normalizeForCompare(v) && /^0x[0-9a-f]{40}$/.test(v)
}

/**
 * A public PGP armor: the original text may contain only space, tab, CR and LF from the set S; the block header is
 * detected on the normalised text. The value itself is not rewritten.
 */
export function isPublicArmor(v: unknown): boolean {
	if (typeof v !== 'string') return false
	for (const ch of v) {
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue
		if (IN_S_ONE.test(ch)) return false
	}
	return normalizeForCompare(v).toUpperCase().includes('BEGINPGPPUBLICKEYBLOCK')
}

/**
 * The public fields of a capability-branch payload must be canonical. For init they sit under `identity`; for
 * provisionIdentity they are flat. Throws with the field name only (bad_identity).
 */
export function assertPublicIdentity(payload: Record<string, unknown>, where: string): void {
	const nested = payload.identity
	const fields = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : payload
	if (!isCanonicalEoa(fields.eoa)) throw new Error(`${where}: bad_identity (eoa)`)
	if (fields.pgpPublicKeyArmored !== undefined && !isPublicArmor(fields.pgpPublicKeyArmored)) {
		throw new Error(`${where}: bad_identity (pgpPublicKeyArmored)`)
	}
	if (fields.ownRouteArmoredPublicKey !== undefined && !isPublicArmor(fields.ownRouteArmoredPublicKey)) {
		throw new Error(`${where}: bad_identity (ownRouteArmoredPublicKey)`)
	}
}

/**
 * Guard for every capability-branch payload, in the vector's order: key material first (key_over_bridge_refused), then
 * the key whitelist and the canonical public identity (bad_identity). Messages name fields only, never values.
 */
export function assertCapabilityPayload(payload: Record<string, unknown>, where: string): void {
	assertNoKeyMaterial(payload, where)
	const badKey = findBadKey(payload)
	if (badKey !== null) throw new Error(`${where}: bad_identity (key ${badKey})`)
	assertPublicIdentity(payload, where)
}
