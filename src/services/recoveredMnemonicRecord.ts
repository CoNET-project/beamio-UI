/**
 * rule 2026-11-16 (1c): a mnemonic the native shell returns for a restore is written into the PWA's own record, in the record's
 * existing format. The mnemonic goes in the plain `mnemonicPhrase` secret field; wrapForDisk wraps it (device key, AES-GCM) on its
 * way to the store, and in a shell the store is the native record (shellRecordWrite). No new plaintext field is introduced.
 */
import { validMnemonicEoa } from '@/utils/consumerWalletGate'

type Loose = Record<string, unknown>

/**
 * The record to persist for a restored account: the public seed, the mnemonic (plain, before wrapping) and, when the native side supplies
 * one (the walletCredential path), the sealed blob. The start-up pre-read carries no blob, so none is written for it.
 */
export function recoveredPageRecord(seed: Loose, phrase: string, blob?: string): Loose {
	return blob ? { ...seed, walletCredentialBlob: blob, mnemonicPhrase: phrase } : { ...seed, mnemonicPhrase: phrase }
}

/** Checks a read-back record: `valid` only when its plain mnemonic derives the expected EOA. */
export function checkRecoveredRecord(readBack: Loose | null | undefined, eoa: string): 'valid' | 'mismatch' | 'missing' {
	const phrase = typeof readBack?.mnemonicPhrase === 'string' ? readBack.mnemonicPhrase.trim() : ''
	if (!phrase) return 'missing'
	const derived = validMnemonicEoa(readBack as never)
	return derived && derived.toLowerCase() === eoa.toLowerCase() ? 'valid' : 'mismatch'
}

/**
 * Shell read-back (2026-11-17 review, reproduced by App.entryPoints R1): the shell strips mnemonicPhrase on every write (stripWalletFields),
 * so a shell read-back never carries it. The phrase goes to the native side only through pwaWalletSync. The shell check is therefore the
 * keyID of the read-back against the EOA, not the phrase: 'valid' when profiles[0].keyID equals eoa, 'missing' when there is no profile,
 * 'mismatch' otherwise. The browser keeps checkRecoveredRecord (its record keeps the plain phrase).
 *
 * Only the keyID is checked here. The phrase is checked before it is written: holdShellSessionFromPhrase (the restore) or the E7 pre-read check
 * (the adopt) has already derived the EOA from the phrase and matched it to this account, so the read-back needs no phrase.
 */
export function checkShellReadBack(readBack: Loose | null | undefined, eoa: string): 'valid' | 'mismatch' | 'missing' {
	const profiles = Array.isArray(readBack?.profiles) ? (readBack?.profiles as Loose[]) : []
	const keyID = typeof profiles[0]?.keyID === 'string' ? (profiles[0].keyID as string).trim().toLowerCase() : ''
	if (!keyID) return 'missing'
	return keyID === eoa.trim().toLowerCase() ? 'valid' : 'mismatch'
}
