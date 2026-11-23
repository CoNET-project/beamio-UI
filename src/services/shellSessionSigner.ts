/**
 * Shell: the EOA key of the native account, held in page memory for the page session. The key is derived from the sealed credential
 * after the native layer unseals it, and the derived address must equal the native account; otherwise nothing is held.
 *
 * Constraints:
 * - Never written to IndexedDB, localStorage, sessionStorage, logs, or the network. The record write strips the profile key
 *   (stripWalletFields), and nothing here logs the key or the phrase.
 * - Only the in-memory profile of the held account carries the key, and only while this page session holds it.
 * - Dropped at a sign-out, at a vault lock, at a change of native account, at a native lock, and at a page unload (pagehide that is
 *   not persisted). A dropped key is removed from the in-memory profile as well.
 */
import { ethers } from 'ethers'
import { CoNET_Data, setCoNET_Data } from '../utils/globals'
import { readWalletCredentialUnseal } from './walletCredential'

type Held = { eoa: string; privateKey: string }

/** Dispatched on the window when a held key is dropped, so that any page state copy of the profile is cleared as well. */
export const SHELL_SESSION_KEY_CLEARED_EVENT = 'beamio:shellSessionKeyCleared'

let held: Held | null = null

export type ShellSessionResult = { kind: 'ok' } | { kind: 'refused'; code: string }

const normalize = (eoa: string): string => eoa.trim().toLowerCase()

/** Puts the held key on the in-memory profile of the same account. The write record strips it, so it is never persisted. */
function injectIntoMemory(): void {
	const data = CoNET_Data
	if (!held || !data?.profiles?.length) return
	const p0 = data.profiles[0]
	if (!p0 || normalize(String(p0.keyID ?? '')) !== held.eoa) return
	if (p0.privateKeyArmor === held.privateKey) return
	setCoNET_Data({ ...data, profiles: [{ ...p0, privateKeyArmor: held.privateKey }, ...data.profiles.slice(1)] })
}

function holdFromPhrase(phrase: string, eoa: string, nativeEoa: string | undefined): ShellSessionResult {
	let derived: { address: string; privateKey: string }
	try {
		derived = ethers.Wallet.fromPhrase(phrase)
	} catch {
		return { kind: 'refused', code: 'bad_phrase' }
	}
	if (derived.address.toLowerCase() !== eoa || (nativeEoa !== undefined && normalize(nativeEoa) !== eoa)) {
		return { kind: 'refused', code: 'eoa_mismatch' }
	}
	held = { eoa, privateKey: derived.privateKey }
	injectIntoMemory()
	return { kind: 'ok' }
}

/**
 * Derives the key from the sealed credential, checks the address against the native account, and holds it. Fails closed:
 * on any refusal nothing is held and the previous key (for another account) is dropped.
 */
export async function loadShellSessionSigner(blob: string, expectedEoa: string): Promise<ShellSessionResult> {
	const eoa = normalize(expectedEoa)
	if (!/^0x[0-9a-f]{40}$/.test(eoa)) return { kind: 'refused', code: 'bad_expected_eoa' }
	if (held && held.eoa === eoa) {
		injectIntoMemory()
		return { kind: 'ok' }
	}
	// switching account: the previous signer is dropped without touching the in-memory profile (release, no blanking)
	if (held) releaseShellSessionSignerHold()
	const answer = await readWalletCredentialUnseal(blob)
	if (answer.kind !== 'credential') return { kind: 'refused', code: answer.code }
	return holdFromPhrase(answer.mnemonic, eoa, answer.eoa)
}

/** Whether a record already carries an account key on its first profile (a record the native layer holds with its key). */
export function recordCarriesAccountKey(record: { profiles?: unknown }): boolean {
	const profiles = record.profiles
	if (!Array.isArray(profiles) || profiles.length === 0) return false
	const key = (profiles[0] as { privateKeyArmor?: unknown } | null | undefined)?.privateKeyArmor
	return typeof key === 'string' && key.trim() !== ''
}

/** Puts the held key on the in-memory profile again (after the in-memory record was replaced for the same account). */
export function refreshShellSessionInMemory(): void {
	injectIntoMemory()
}

/** Holds the key derived from a phrase the native layer has just unsealed (the page copy). Nothing is held on a mismatch. */
export function holdShellSessionFromPhrase(phrase: string, expectedEoa: string): ShellSessionResult {
	const eoa = normalize(expectedEoa)
	// switching account: the previous signer is dropped without touching the in-memory profile (release, no blanking)
	if (held && held.eoa !== eoa) releaseShellSessionSignerHold()
	return holdFromPhrase(phrase, eoa, undefined)
}

/** The page-held key for this account, or '' when none is held for it. Synchronous, for the signing callers. */
export function shellSessionPrivateKeyFor(eoa: string): string {
	return held && held.eoa === normalize(eoa) ? held.privateKey : ''
}

/** The account the session holds a key for, or ''. */
export function shellSessionEoa(): string {
	return held?.eoa ?? ''
}

/** A copy of a record with the held key on its first profile, when that profile is the held account and has no key. The input is not changed. */
export function injectShellSessionKey<T extends { profiles?: unknown }>(record: T): T {
	if (!held) return record
	const profiles = record.profiles
	if (!Array.isArray(profiles) || profiles.length === 0) return record
	const p0 = profiles[0] as { keyID?: unknown; privateKeyArmor?: unknown } | null | undefined
	if (!p0 || normalize(typeof p0.keyID === 'string' ? p0.keyID : '') !== held.eoa) return record
	if (typeof p0.privateKeyArmor === 'string' && p0.privateKeyArmor.trim() !== '') return record
	return { ...record, profiles: [{ ...p0, privateKeyArmor: held.privateKey }, ...profiles.slice(1)] } as T
}

/** Drops the held key and removes it from the in-memory profile. */
/**
 * 0.53.39 (review, item 2): drops the held signer WITHOUT changing the in-memory profile. Used where a restore is about to
 * replace the session account: the page profile is left as it is (no blanked privateKeyArmor can reach a later write), and the held key is
 * no longer used for signing. The window event tells any page copy that the held key was dropped.
 */
export function releaseShellSessionSignerHold(): void {
	const had = held
	held = null
	if (!had) return
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHELL_SESSION_KEY_CLEARED_EVENT))
}

export function clearShellSessionSigner(): void {
	const had = held
	held = null
	if (!had) return
	const data = CoNET_Data
	const p0 = data?.profiles?.[0]
	if (data && p0 && p0.privateKeyArmor === had.privateKey) {
		setCoNET_Data({ ...data, profiles: [{ ...p0, privateKeyArmor: '' }, ...data.profiles.slice(1)] })
	}
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHELL_SESSION_KEY_CLEARED_EVENT))
}

if (typeof window !== 'undefined') {
	// a real unload drops the key; a page restored from the back-forward cache (persisted) keeps it.
	window.addEventListener('pagehide', (e: PageTransitionEvent) => {
		// a real unload drops the held signer only (release: no profile blanking; the page is going away)
		if (!e.persisted) releaseShellSessionSignerHold()
	})
}
