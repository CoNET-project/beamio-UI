/**
 * In-shell page-key step 1 (plan ): the secret fields of a profile tree are removed in place when the page
 * is a shell. The stored copy is not touched here; persistence keeps stored secrets when the page copy is empty (see
 * walletVault.wrapForPersist). Browser behaviour is unchanged: nothing is removed outside a shell.
 */
import { ethers } from 'ethers'

/** Profile fields that hold key material or the backup words, with their wrapped siblings. */
// Boundary: EOA key material stays with the page as before; no EOA field is stripped in a shell.
export const SHELL_SECRET_FIELDS = [] as const

type Loose = Record<string, unknown>

const isObject = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

/** Removes the secret fields from one profile (and its PGP key objects) in place. */
function stripProfile(p: Loose): void {
	for (const f of SHELL_SECRET_FIELDS) delete p[f]
	// Scrub only: the secret fields of the PGP key record are deleted by name; nothing is read or kept.
	const PGP_SECRET_FIELDS = ['privateKey', 'privateKeyArmor', 'privateKeyArmorWrap'] as const
	for (const key of ['pgpKey'] as const) {
		const k = p[key]
		if (isObject(k)) for (const f of PGP_SECRET_FIELDS) delete k[f]
	}
	const chat = p.chatManager
	if (isObject(chat) && isObject(chat.pgpKey)) for (const f of PGP_SECRET_FIELDS) delete chat.pgpKey[f]
}

/**
 * Walks `profiles` (nested arrays allowed, as in the vault) and removes the secret fields in place. Returns the same object.
 * A non-shell caller must not use this; the setter applies it only inside a shell.
 */
export function stripShellSecrets<T>(data: T): T {
	// Boundary: the EOA fields stay with the page; only the PGP passphrase is removed at the top level.
	if (isObject(data)) delete (data as Loose).pgpPassphrase
	const walk = (list: unknown): void => {
		if (!Array.isArray(list)) return
		for (const item of list) {
			if (Array.isArray(item)) walk(item)
			else if (isObject(item)) stripProfile(item)
		}
	}
	if (isObject(data)) walk((data as Loose).profiles)
	return data
}

const PGP_KEEP_FIELDS = ['privateKey', 'privateKeyArmor', 'privateKeyArmorWrap'] as const

/** Copies one PGP key record's secret fields from the stored copy into the write copy, when the write copy lacks them. */
function keepPgpRecord(stored: unknown, out: unknown): void {
	if (!isObject(stored) || !isObject(out)) return
	for (const f of PGP_KEEP_FIELDS) {
		if (out[f] === undefined && stored[f] !== undefined) out[f] = stored[f]
	}
}

/**
 * The write-layer record: a copy of `out` (nothing shared with the page state) with the stored PGP secret fields put back.
 * Design note: the write-layer record is a separate copy, so a write never shares the page state object.
 */
export function pgpSecretsKeptForDisk(stored: unknown, out: Loose): Loose {
	const copy = JSON.parse(JSON.stringify(out)) as Loose
	keepStoredPgpSecrets(stored, copy)
	return copy
}

/**
 * Boundary: removing the PGP private key from the page copy must not erase it from the store.
 * On the write path in a shell, the PGP secret fields of the stored record are copied back, unchanged, into the record that
 * is about to be written (matched by position and keyID). The values are never added to the in-memory wallet state.
 */
export function keepStoredPgpSecrets(stored: unknown, out: unknown): void {
	if (!isObject(stored) || !isObject(out)) return
	if (isObject(stored) && (stored as Loose).pgpPassphrase !== undefined && (out as Loose).pgpPassphrase === undefined) {
		;(out as Loose).pgpPassphrase = (stored as Loose).pgpPassphrase
	}
	const flat = (list: unknown): Loose[] => {
		const acc: Loose[] = []
		const walk = (l: unknown): void => {
			if (Array.isArray(l)) l.forEach(walk)
			else if (isObject(l)) acc.push(l)
		}
		walk(list)
		return acc
	}
	const storedProfiles = flat((stored as Loose).profiles)
	const outProfiles = flat((out as Loose).profiles)
	outProfiles.forEach((o, i) => {
		const s = storedProfiles.find((p) => p.keyID === o.keyID) ?? storedProfiles[i]
		if (!s) return
		if (isObject(s.pgpKey)) {
			if (!isObject(o.pgpKey)) o.pgpKey = {}
			keepPgpRecord(s.pgpKey, o.pgpKey)
		}
		if (isObject(s.chatManager) && isObject(s.chatManager.pgpKey)) {
			if (!isObject(o.chatManager)) o.chatManager = {}
			const oc = o.chatManager as Loose
			if (!isObject(oc.pgpKey)) oc.pgpKey = {}
			keepPgpRecord(s.chatManager.pgpKey, oc.pgpKey)
		}
	})
}

/**
 * The account address of a profile, from its public `keyID` (the EOA,  and beamio.ts). Returns `undefined` when the
 * `keyID` is not an address. It never reads a key.
 */
export function accountAddressOf(profile: { keyID?: unknown } | null | undefined): string | undefined {
	const k = typeof profile?.keyID === 'string' ? profile.keyID.trim() : ''
	return ethers.isAddress(k) ? ethers.getAddress(k) : undefined
}
