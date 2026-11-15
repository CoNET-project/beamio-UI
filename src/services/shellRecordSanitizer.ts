/**
 * The page never holds or sends a PGP private key. The record
 * that crosses the native bridge is checked here (the native side checks it again: two-sided). Forbidden paths and the PGP
 * header are refused before anything is sent. The W-class fields (EOA private key and mnemonic) are native-owned: the page
 * never sends them, so the native side keeps its own copy (2 rule 1); the native encrypted copy is approved.
 * The public PGP key and key id are not PGP private material.
 */

import { ethers } from 'ethers'

const PGP_PRIVATE_FIELDS = ['privateKey', 'privateKeyArmor', 'privateKeyArmorWrap'] as const
/**8: the PGP header in any string value, at any path. */
// Detector constant: the header is matched, not used as key material (no key material in this file).
const PGP_HEADER = 'BEGIN PGP PRIVATE KEY'
/**8: the page record must not carry these paths (the legacy PWA copy could hold them). */
const CHAT_PRIVATE_ARMORED = 'privateArmored'

type Loose = Record<string, unknown>
const isObject = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

function walkProfiles(list: unknown, visit: (profile: Loose) => void): void {
	if (Array.isArray(list)) list.forEach((x) => walkProfiles(x, visit))
	else if (isObject(list)) visit(list)
}

/** Paths of PGP private fields in a record (paths only; no value is returned). */
export function pgpPrivatePaths(record: unknown): string[] {
	const out: string[] = []
	if (!isObject(record)) return out
	walkProfiles((record as Loose).profiles, (p) => {
		const cm = p.chatManager
		if (isObject(cm) && isObject(cm.pgpKey)) {
			for (const f of PGP_PRIVATE_FIELDS) if (cm.pgpKey[f] !== undefined) out.push(`profiles[].chatManager.pgpKey.${f}`)
		}
		if (isObject(p.pgpKey)) {
			for (const f of PGP_PRIVATE_FIELDS) if (p.pgpKey[f] !== undefined) out.push(`profiles[].pgpKey.${f}`)
		}
		if (Array.isArray(p.chats)) {
			for (const c of p.chats) {
				if (isObject(c) && isObject(c.chatData) && c.chatData[CHAT_PRIVATE_ARMORED] !== undefined) out.push('profiles[].chats[].chatData.privateArmored')
			}
		}
	})
	if ((record as Loose).pgpPassphrase !== undefined) out.push('pgpPassphrase')
	return out
}

/** Count of string values carrying the PGP header, at any path (the header itself is never returned). */
export function pgpHeaderCount(value: unknown): number {
	if (typeof value === 'string') return value.includes(PGP_HEADER) ? 1 : 0
	if (Array.isArray(value)) return value.reduce<number>((n, v) => n + pgpHeaderCount(v), 0)
	if (isObject(value)) return Object.keys(value).reduce<number>((n, k) => n + pgpHeaderCount(value[k]), 0)
	return 0
}

/** W-class paths (EOA private key and mnemonic) present in a record (paths only; no value is returned). */
export function walletCopyPaths(record: unknown): string[] {
	const out: string[] = []
	if (!isObject(record)) return out
	walkProfiles((record as Loose).profiles, (p) => {
		if (p.privateKeyArmor !== undefined) out.push('profiles[].privateKeyArmor')
	})
	// the page's mnemonic key is the top-level `mnemonicPhrase`(encrypt_keys_object, hasLocalPlaintextMnemonic).
	if ((record as Loose).mnemonicPhrase !== undefined) out.push('mnemonicPhrase')
	// the W-class secret kept under the top-level `recoveryWords`(walletVault secret slot).
	if ((record as Loose).recoveryWords !== undefined) out.push('recoveryWords')
	return out
}

export type ShellWalletState = 'ok' | 'needs_native_recovery' | 'wallet_fields_missing' | 'duplicate_profiles'

const profileList = (profiles: unknown): Loose[] => {
	const out: Loose[] = []
	walkProfiles(profiles, (p) => out.push(p))
	return out
}

/** The EOA private key (armor) derives to the account address. False when the armor is blank or not a private key. */
function keyDerivesTo(armor: unknown, eoaLower: string): boolean {
	if (typeof armor !== 'string' || !armor.trim()) return false
	try {
		return new ethers.Wallet(armor.trim()).address.toLowerCase() === eoaLower
	} catch {
		return false
	}
}

/**
 * The state of a shell record. The account is the first profile's keyID, which must be a valid address
 * (the same predicate as the page gate, consumerWalletGate.ts). The EOA private key must sit on the profile bound to that
 * keyID and derive to it. The mnemonic, the @beamioTag and the account name are not required here.
 *  - ok: the record is entered; the app handles a missing tag or name.
 *  - needs_native_recovery: the bound profile has no EOA private key that derives to the account, and no sealed credential (a mnemonic alone does not count).
 *  - wallet_fields_missing: no valid account EOA (malformed record): a hold, never onboarding.
 * Only a confirmed-absent store reaches onboarding; none of these states does.
 */
/**
 * An account address as the page accepts it: a lower-case or upper-case address (no mixed case) is accepted; a mixed-case
 * address must carry a valid checksum. Returns the checksum form, or null (a damaged record).
 */
export function canonicalAccountAddress(raw: string): string | null {
	const s = raw.trim()
	if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null
	const hex = s.slice(2)
	if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return ethers.getAddress(`0x${hex.toLowerCase()}`)
	return ethers.isAddress(s) ? ethers.getAddress(s) : null
}

/** The profile addresses in their checksum form (the app reads them with getAddress). The same object when nothing changes. */
export function canonicalizeProfileKeyIDs<T>(record: T): T {
	if (!isObject(record) || !Array.isArray((record as Loose).profiles)) return record
	const profiles = (record as Loose).profiles
	const needs = profileList(profiles).some((p) => {
		if (typeof p.keyID !== 'string') return false
		const c = canonicalAccountAddress(p.keyID)
		return c !== null && c !== p.keyID
	})
	if (!needs) return record
	const copy = JSON.parse(JSON.stringify(record)) as Loose
	walkProfiles(copy.profiles, (p) => {
		if (typeof p.keyID !== 'string') return
		const c = canonicalAccountAddress(p.keyID)
		if (c !== null) p.keyID = c
	})
	return copy as T
}

export function shellWalletState(record: unknown): ShellWalletState {
	// the EOA private key is the only required item. The account is the profile at index 0, named by its keyID; the key
	// must sit on the profile bound to that keyID and derive to it. : the address form is accepted when it is not mixed-case
	// or its checksum is valid; a damaged address is wallet_fields_missing (a hold).
	if (!isObject(record) || !Array.isArray((record as Loose).profiles)) return 'wallet_fields_missing'
	const profiles = (record as Loose).profiles
	const first = Array.isArray(profiles) ? profiles[0] : undefined
	const rawKey = isObject(first) && typeof first.keyID === 'string' ? first.keyID.trim() : ''
	if (!rawKey) return 'needs_native_recovery'
	const canonical = canonicalAccountAddress(rawKey)
	if (!canonical) return 'wallet_fields_missing'
	const accountKey = canonical.toLowerCase()
	const bound = profileList(profiles).filter((p) => typeof p.keyID === 'string' && p.keyID.trim().toLowerCase() === accountKey)
	// duplicate profiles for the account cannot be selected safely (the app reads profiles[0]): a hold, never onboarding.
	if (bound.length > 1) return 'duplicate_profiles'
	if (bound.some((p) => keyDerivesTo(p.privateKeyArmor, accountKey))) return 'ok'
	// A sealed credential is the other source: the native layer unseals it for one operation, and the EOA it yields is checked
	// against the native account at that use (fail closed). The gate checks the record's account against the native account first.
	if (hasSealedCredential(record)) return 'ok'
	return 'needs_native_recovery'
}

function hasSealedCredential(record: unknown): boolean {
	if (!isObject(record)) return false
	const blob = (record as Loose).walletCredentialBlob
	return typeof blob === 'string' && blob.trim() !== ''
}

/**
 * Scheme A: the EOA private key is what a shell record must hold. A record without it is an error. A missing
 * mnemonic is not an error here: the shell keeps the EOA key natively and never routes to page recovery.
 */
export function eoaPrivateKeyPresent(record: unknown): boolean {
	if (!isObject(record)) return false
	let found = false
	walkProfiles((record as Loose).profiles, (p) => {
		const v = p.privateKeyArmor
		if (v !== undefined && v !== null && v !== '') found = true
	})
	return found
}

/** A copy of the record without the PGP private fields and the chat private armor. The input is not changed. W-class fields are kept here; see stripWalletFields. */
export function sanitizeForBridge<T>(record: T): T {
	const copy = JSON.parse(JSON.stringify(record ?? null)) as T
	if (!isObject(copy)) return copy
	walkProfiles((copy as Loose).profiles, (p) => {
		const cm = p.chatManager
		if (isObject(cm) && isObject(cm.pgpKey)) for (const f of PGP_PRIVATE_FIELDS) delete cm.pgpKey[f]
		if (isObject(p.pgpKey)) for (const f of PGP_PRIVATE_FIELDS) delete p.pgpKey[f]
		if (Array.isArray(p.chats)) {
			for (const c of p.chats) if (isObject(c) && isObject(c.chatData)) delete c.chatData[CHAT_PRIVATE_ARMORED]
		}
	})
	delete (copy as Loose).pgpPassphrase
	return copy
}

/** Throws `pgp_private_in_payload` when a PGP private path or the PGP header is present. Only paths and counts are reported. */
export function assertNoPgpPrivate(record: unknown): void {
	const paths = pgpPrivatePaths(record)
	const headers = pgpHeaderCount(record)
	if (paths.length || headers) throw new Error(`pgp_private_in_payload: ${paths.length} path(s), ${headers} header(s)`)
}

/**
 * PGP public fields: the PGP key container at profiles[*].chatManager.pgpKey and
 * profiles[*].pgpKey. A page copy that carries any of them is refused (`pgp_field_not_allowed`, with path names only); the page
 * never strips them silently. Paths only; no value is returned.
 */
export function pgpPublicPaths(record: unknown): string[] {
	const out: string[] = []
	if (!isObject(record)) return out
	walkProfiles((record as Loose).profiles, (p) => {
		if (isObject(p.chatManager) && (p.chatManager as Loose).pgpKey !== undefined) out.push('profiles[].chatManager.pgpKey')
		if (p.pgpKey !== undefined) out.push('profiles[].pgpKey')
	})
	// (TR-37): a chat's peer PGP public armor is PGP public: refused, not stored in a shell copy.
	walkProfiles((record as Loose).profiles, (p) => {
		if (!Array.isArray(p.chats)) return
		for (const c of p.chats) {
			if (isObject(c) && isObject(c.chatData) && (c.chatData as Loose).publicArmored !== undefined) out.push('profiles[].chats[].chatData.publicArmored')
		}
	})
	// the account's PGP public material kept under `beamio`(the page's own copy of the account) is PGP public too.
	if (isObject((record as Loose).beamio)) {
		const b = (record as Loose).beamio as Loose
		if (b.pgpPublicKeyID !== undefined) out.push('beamio.pgpPublicKeyID')
		if (b.pgpPublicKeyArmor !== undefined) out.push('beamio.pgpPublicKeyArmor')
	}
	return out
}

/** A chat's data without its peer PGP public armor: in a shell the peer key is not kept in the page copy. */
export function withoutPeerPublicArmor<T>(chatData: T): T {
	if (!isObject(chatData)) return chatData
	const copy = { ...(chatData as Loose) }
	delete copy.publicArmored
	return copy as T
}

/** The account copy without its PGP public fields (shell): the page keeps them only from identityPublic, never stored. */
export function stripPgpPublicFromBeamio<T>(b: T): T {
	if (!isObject(b)) return b
	const copy = { ...(b as Loose) }
	delete copy.pgpPublicKeyID
	delete copy.pgpPublicKeyArmor
	return copy as T
}

/**
 * The write copy without the W-class fields (2 rule 1): the native side keeps the W fields it already holds, so an
 * omitted W field is kept and the page never replaces them by a whole-record write. The input is not changed.
 */
export function stripWalletFields<T>(record: T): T {
	const copy = JSON.parse(JSON.stringify(record ?? null)) as T
	if (!isObject(copy)) return copy
	walkProfiles((copy as Loose).profiles, (p) => {
		delete p.privateKeyArmor
		// The device/passcode wrap of the same W field (walletVault slot sibling): W material too, so the page never sends it.
		delete p.privateKeyArmorWrap
	})
	// the mnemonic is the top-level `mnemonicPhrase`in the page record. The legacy names are removed too (never sent).
	delete (copy as Loose).mnemonicPhrase
	// `recoveryWords`is a W-class secret too (the same rule as the mnemonic).
	delete (copy as Loose).recoveryWords
	if (isObject((copy as Loose).walletVault)) delete ((copy as Loose).walletVault as Loose).mnemonic
	delete (copy as Loose).mnemonic
	return copy
}

/** UTF-8 byte length of a string (the bridge limit is in bytes). */
export function utf8ByteLength(s: string): number {
	let n = 0
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
	}
	return n
}

/** The page record's size limit on each side of the bridge (6: 2 MB). */
export const BRIDGE_LIMIT_BYTES = 2 * 1024 * 1024
