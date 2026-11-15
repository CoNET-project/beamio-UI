/**
 * The page record against the native account, decided before the page uses or copies it. The native account comes from
 * walletEoaAddress. A refusal, a timeout, an unavailable store, or a native account that changed since the start is a retry:
 * nothing is used or stored, and the next start decides again. Only an empty store allows a copy, and nothing here creates a wallet.
 */
import type { WalletEoaAddressAnswer } from './walletEoaAddress'
import { pageRecordAccountMatches } from './walletCredential'

export type PageRecordRead =
	| { status: 'loaded'; data: { profiles?: unknown; walletCredentialBlob?: unknown } }
	| { status: 'empty' }
	| { status: 'other' }

export type PageRecordDecision = 'use' | 'empty' | 'eoa_mismatch' | 'retry' | 'update_required' | 'record_unavailable'

/**
 * A refused native account read is decided by the shell's code: `not_trusted` asks for an app update; `origin_refused` is an
 * origin error (the record is unavailable, no update prompt); anything else is a retry.
 */
function refusalDecision(code: string): PageRecordDecision {
	if (code === 'not_trusted') return 'update_required'
	if (code === 'origin_refused') return 'record_unavailable'
	return 'retry'
}

/** A usable credential is a sealed blob (unsealed per use) or a page-held key. */
function hasUsableCredential(data: { profiles?: unknown; walletCredentialBlob?: unknown }): boolean {
	if (typeof data.walletCredentialBlob === 'string' && data.walletCredentialBlob.trim() !== '') return true
	const profiles = Array.isArray(data.profiles) ? data.profiles : []
	return profiles.some((p) => {
		const key = (p as { privateKeyArmor?: unknown } | null | undefined)?.privateKeyArmor
		return typeof key === 'string' && key.trim() !== ''
	})
}

export function decidePageRecord(read: PageRecordRead, native: WalletEoaAddressAnswer, eoa: string): PageRecordDecision {
	// The native account must answer, and it must be the account this start entered. Otherwise nothing is decided.
	if (native.kind !== 'address') return refusalDecision(native.code)
	if (native.eoa !== eoa.trim().toLowerCase()) return 'retry'
	if (read.status === 'other') return 'retry'
	if (read.status === 'empty') return 'empty'
	if (!pageRecordAccountMatches(read.data, native.eoa)) return 'eoa_mismatch'
	return hasUsableCredential(read.data) ? 'use' : 'retry'
}

/**
 * The shell record read (the main read path). The record is returned only when its account is the native account and it holds a
 * credential. A refusal, a timeout or an unavailable native account is a retry; a different account is eoa_mismatch. Nothing is used otherwise.
 */
export function shellRecordReadState(
	record: { profiles?: unknown; walletCredentialBlob?: unknown },
	native: WalletEoaAddressAnswer,
): { kind: 'use' } | { kind: 'unavailable'; reason: 'eoa_mismatch' | 'native_retry' | 'app_update_required' | 'native_record' } {
	const decision = decidePageRecord({ status: 'loaded', data: record }, native, native.kind === 'address' ? native.eoa : '')
	if (decision === 'use') return { kind: 'use' }
	if (decision === 'eoa_mismatch') return { kind: 'unavailable', reason: 'eoa_mismatch' }
	if (decision === 'update_required') return { kind: 'unavailable', reason: 'app_update_required' }
	if (decision === 'record_unavailable') return { kind: 'unavailable', reason: 'native_record' }
	return { kind: 'unavailable', reason: 'native_retry' }
}
