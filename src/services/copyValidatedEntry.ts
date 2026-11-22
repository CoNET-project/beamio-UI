/**
 *when the page copy is validated natively for this account
 * (`copyValidated`), the entry follows the native derivation path. The page does not derive or hold a key from the copy
 * (no holdFromPhrase, no loadShellSessionSigner) at any of the three entry points. The three helpers below are the explicit decisions.
 * A key held by another path is not decided here.
 */
import type { CheckStorageResult } from './beamio'
import type { ShellSessionResult } from './shellSessionSigner'
import type { WalletEoaAddressAnswer } from './walletEoaAddress'
import { NO_KEY_ERROR } from './nativeKeyState'
import { isMnemonicPhrase } from './walletCredential'
import { ethers } from 'ethers'

type StorageRead = CheckStorageResult | { status: 'empty' } | { status: 'other' }

/**
 * The copy is validated natively. All three must hold, and none is derived on the page:
 * - the native copyValidated flag;
 * - the copy's mnemonic is non-empty and passes the BIP-39 checksum (no derivation here);
 * - the copy's keyID equals the native walletEoaAddress (`eoa`), or, with `eoa` '', any non-empty keyID.
 */
export function isNativeCopyValidated(read: StorageRead, eoa: string): boolean {
	if (!hasNativeCopyFlag(read)) return false
	const data = (read as { data: { profiles?: unknown; mnemonicPhrase?: unknown } }).data
	if (!isMnemonicPhrase(copyPhrase(data))) return false
	const keyID = copyKeyID(data)
	if (eoa === '') return keyID !== ''
	return keyID !== '' && keyID === eoa.trim().toLowerCase()
}

/** The native copyValidated flag on a loaded record (the flag only; the phrase and the keyID are checked by the caller). */
function hasNativeCopyFlag(read: StorageRead): boolean {
	return read.status === 'loaded' && (read as { copyValidated?: boolean }).copyValidated === true
}

function copyKeyID(data: { profiles?: unknown }): string {
	const profiles = data.profiles
	const first = Array.isArray(profiles) ? (profiles[0] as { keyID?: unknown } | undefined) : undefined
	return typeof first?.keyID === 'string' ? first.keyID.trim().toLowerCase() : ''
}

function copyPhrase(data: { mnemonicPhrase?: unknown }): string {
	return typeof data.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
}

export type PrepareEntry = 'enter' | 'eoa_mismatch' | 'update_required' | 'unseal_failed' | 'retry' | 'record_unavailable'

/**
 * prepareShellEntry after the bounded page read. A native-validated copy enters on the native path and never calls the sealed-credential
 * hold. Other records keep the existing decision (the blob hold through `hold`).
 */
export async function decidePrepareEntry(
	pre: CheckStorageResult,
	eoa: string,
	hold: (blob: string, eoa: string) => Promise<ShellSessionResult>,
): Promise<PrepareEntry> {
	if (pre.status === 'unavailable' && pre.reason === 'eoa_mismatch') return 'eoa_mismatch'
	if (pre.status === 'unavailable' && pre.reason === 'native_retry') return 'retry'
	if (pre.status === 'unavailable' && pre.reason === 'app_update_required') return 'update_required'
	// a failed page-record read does not hold the native entry: the background copy decides (and shows the record-unavailable state).
	if (pre.status !== 'loaded') return 'enter'
	if (isNativeCopyValidated(pre, eoa)) return 'enter'
	// Decision (2026-11-17): a key or wallet record without a valid mnemonic is not an account credential. It never enters by itself: the
	// native account decides (the caller entered on the native account already). Only a record with a valid mnemonic may skip the sealed hold.
	if (recordHasAccountKey(pre.data) && validPhraseEoa(pre.data) !== '') return 'enter'
	const blob = pre.data.walletCredentialBlob
	if (!blob) return 'enter'
	const held = await hold(blob as string, eoa)
	if (held.kind === 'ok') return 'enter'
	if (held.code === 'eoa_mismatch') return 'eoa_mismatch'
	if (held.code === 'not_trusted') return 'update_required'
	if (['locked', 'unavailable', 'not_ready', 'timeout', 'keychain_read_failed'].includes(held.code)) return 'retry'
	return 'unseal_failed'
}

/** The pre-read valid path: a native-validated copy for the same account enters on the native path; otherwise the pre-read is adopted. */
export async function decidePrereadEntry(
	pageCopy: CheckStorageResult,
	preEoa: string,
	native: () => void,
	adopt: () => Promise<void>,
): Promise<'native' | 'adopted'> {
	if (isNativeCopyValidated(pageCopy, preEoa)) {
		native()
		return 'native'
	}
	await adopt()
	return 'adopted'
}

/**
 * restorePageCopy before the page asks for a credential or holds a key: a native-validated copy for this account is the native path
 * (nothing is asked, held or written here).
 */
export function copyPreHoldAction(stored: StorageRead, eoa: string): 'native' | 'proceed' {
	return isNativeCopyValidated(stored, eoa) ? 'native' : 'proceed'
}

function recordHasAccountKey(data: { profiles?: unknown }): boolean {
	const profiles = data.profiles
	if (!Array.isArray(profiles) || profiles.length === 0) return false
	const key = (profiles[0] as { privateKeyArmor?: unknown } | null | undefined)?.privateKeyArmor
	return typeof key === 'string' && key.trim() !== ''
}

/** Page evidence of a start-up read for a validated copy (the gate's readPageMnemonic). Null when the copy is not validated. */
export type CopyPageEvidence = { kind: 'valid'; eoa: string; phrase: string; nativeValidated: true } | { kind: 'unknown' }

/**
 *a validated copy takes its EOA from the native side, never from the page.
 * - native address equal to the copy's EOA → valid with the native EOA;
 * - native no_key → the expected answer for a validated copy (beamio.ts ~1697): valid with the copy's EOA (keyID), no hold;
 * - native address for another account, or any other refusal (a read failure, not ready, unknown) → unknown (held, retried, nothing written).
 */
export function copyPageEvidence(read: CheckStorageResult, native: WalletEoaAddressAnswer): CopyPageEvidence | null {
	// no native flag: this is not a validated copy, so there is no copy evidence at all.
	if (!hasNativeCopyFlag(read)) return null
	const data = (read as { data: { profiles?: unknown; mnemonicPhrase?: unknown } }).data
	const keyID = copyKeyID(data)
	const phrase = copyPhrase(data)
	// a validated copy whose phrase fails the checksum, or has no keyID, is unknown (held, nothing sent)
	if (!isMnemonicPhrase(phrase) || keyID === '') return { kind: 'unknown' }
	if (native.kind === 'address') {
		return native.eoa.trim().toLowerCase() === keyID ? { kind: 'valid', eoa: keyID, phrase, nativeValidated: true } : { kind: 'unknown' }
	}
	if (native.code === NO_KEY_ERROR) return { kind: 'valid', eoa: keyID, phrase, nativeValidated: true }
	return { kind: 'unknown' }
}

/** The EOA of the record's valid mnemonic (decision 2026-11-17: the account credential is a valid mnemonic), or '' when none. */
function validPhraseEoa(data: { profiles?: unknown; mnemonicPhrase?: unknown }): string {
	const phrase = typeof data.mnemonicPhrase === 'string' ? data.mnemonicPhrase.trim() : ''
	if (!phrase) return ''
	try {
		return ethers.Wallet.fromPhrase(phrase).address.toLowerCase()
	} catch {
		return ''
	}
}
