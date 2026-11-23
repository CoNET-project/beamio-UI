/**
 * The page record against the native account, decided before the page uses or copies it. The native account comes from
 * walletEoaAddress. A refusal, a timeout, an unavailable store, or a native account that changed since the start is a retry:
 * nothing is used or stored, and the next start decides again. Only an empty store allows a copy, and nothing here creates a wallet.
 */
import type { WalletEoaAddressAnswer } from './walletEoaAddress'
import { pageRecordAccountMatches } from './walletCredential'
import { validMnemonicEoa } from '../utils/consumerWalletGate'
import { isPasscodeNotProvidedAnswer } from './shellStoreWait'

export type PageRecordRead =
	| { status: 'loaded'; data: { profiles?: unknown; walletCredentialBlob?: unknown; mnemonicPhrase?: unknown } }
	| { status: 'empty' }
	| { status: 'other' }

/**
 * use: a readable valid mnemonic (BIP-39 passes, derived EOA = keyID = the native account). retry: a sealed credential whose content is not
 * readable here (hold until it unlocks), or the native side or store is unknown. not_account: readable, but only a private key or an
 * address (no valid mnemonic): not an account credential, so the pre-read route decides (E7, 2026-11-17).
 */
export type PageRecordDecision = 'use' | 'empty' | 'eoa_mismatch' | 'retry' | 'update_required' | 'record_unavailable' | 'not_account' | 'passcode_not_provided'

/**
 * A refused native account read is decided by the shell's code: `not_trusted` asks for an app update; `origin_refused` is an
 * origin error (the record is unavailable, no update prompt); anything else is a retry.
 */
function refusalDecision(code: string): PageRecordDecision {
	if (code === 'not_trusted') return 'update_required'
	if (code === 'origin_refused') return 'record_unavailable'
	// Unit g (2026-11-22): passcode_not_provided is a not_ready class: a background wait, never record_unavailable (native_record) and never a copy.
	if (isPasscodeNotProvidedAnswer(code)) return 'passcode_not_provided'
	return 'retry'
}

/** A sealed credential (walletCredentialBlob): its content is not readable without unlocking, so it is a hold, never a guess. */
function hasSealedCredential(data: { walletCredentialBlob?: unknown }): boolean {
	return typeof data.walletCredentialBlob === 'string' && data.walletCredentialBlob.trim() !== ''
}

export function decidePageRecord(read: PageRecordRead, native: WalletEoaAddressAnswer, eoa: string): PageRecordDecision {
	// The native account must answer, and it must be the account this start entered. Otherwise nothing is decided.
	if (native.kind !== 'address') return refusalDecision(native.code)
	if (native.eoa !== eoa.trim().toLowerCase()) return 'retry'
	if (read.status === 'other') return 'retry'
	if (read.status === 'empty') return 'empty'
	if (!pageRecordAccountMatches(read.data, native.eoa)) return 'eoa_mismatch'
	// The account credential is a valid mnemonic whose derived EOA is the keyID (and the native account). A plaintext mnemonic that does not
	// derive to it is not an account here (the page does not derive the account from a key, E7 / startup classification).
	if (validMnemonicEoa(read.data as never) === native.eoa) return 'use'
	if (hasSealedCredential(read.data)) return 'retry'
	return 'not_account'
}

/**
 * The shell record read (the main read path). The record is returned only when its account is the native account and it holds a
 * credential. A refusal, a timeout or an unavailable native account is a retry; a different account is eoa_mismatch. Nothing is used otherwise.
 */
export function shellRecordReadState(
	record: { profiles?: unknown; walletCredentialBlob?: unknown },
	native: WalletEoaAddressAnswer,
): { kind: 'use' } | { kind: 'not_account' } | { kind: 'unavailable'; reason: 'eoa_mismatch' | 'native_retry' | 'app_update_required' | 'native_record' | 'native_passcode_not_provided' } {
	const decision = decidePageRecord({ status: 'loaded', data: record }, native, native.kind === 'address' ? native.eoa : '')
	if (decision === 'use') return { kind: 'use' }
	// readable, but no valid mnemonic: not an account; the start-up pre-read decides (the caller treats it as no page account)
	if (decision === 'not_account') return { kind: 'not_account' }
	if (decision === 'eoa_mismatch') return { kind: 'unavailable', reason: 'eoa_mismatch' }
	if (decision === 'update_required') return { kind: 'unavailable', reason: 'app_update_required' }
	if (decision === 'record_unavailable') return { kind: 'unavailable', reason: 'native_record' }
	if (decision === 'passcode_not_provided') return { kind: 'unavailable', reason: 'native_passcode_not_provided' }
	return { kind: 'unavailable', reason: 'native_retry' }
}
