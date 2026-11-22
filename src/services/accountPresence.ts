/**
 * Native account presence. Three answers from the walletStatus and identityPublic state the
 * native layer already gives: has (keep the account), confirmed_none (both sides confirmed no wallet), unknown (retry, never
 * onboarding, never a deletion). No extra command.
 */
import type { IdbSignal } from './accountJudgement'

export type NativePresence = 'has' | 'confirmed_none' | 'unknown'

export type NativePresenceInput = {
	/** walletStatus status, or 'unknown' when the snapshot is not known. */
	ws: 'unlocked' | 'locked' | 'phrase_only' | 'not_ready' | 'no_key' | 'unknown'
	/** walletStatus notReadyReason, read only on not_ready. key_only: the record is confirmed to hold no valid mnemonic (CONFIRMED_NONE). */
	reason?: 'g1_uninitialized' | 'key_only' | 'unreadable'
	/** identityPublic kPresent: true, false, or absent (undefined). */
	kPresent?: boolean
	/** The snapshot is not known (native answered not_ready for an unknown snapshot). */
	snapshotUnknown: boolean
}

export function nativePresence(input: NativePresenceInput): NativePresence {
	// TS-05: an unknown snapshot is never a basis for a decision.
	if (input.snapshotUnknown) return 'unknown'
	// / LK-P7: an unlocked wallet (with its account key) is present. A locked wallet is NOT present on this page: the account is
	// unknown until it is unlocked (Q5 A; SDK does not change the G2 shape, so the page holds this line).
	if (input.ws === 'unlocked') return 'has'
	// a phrase_only answer (the native record holds a mnemonic) with an eoa is present.
	if (input.ws === 'phrase_only') return 'has'
	if (input.ws === 'not_ready') {
		// TS-02: an uninitialised record (G1) is present. key_only: the record holds no valid mnemonic (CONFIRMED_NONE).
		// TS-04: unreadable, or no reason, or an unknown reason, is unknown.
		if (input.reason === 'g1_uninitialized') return 'has'
		if (input.reason === 'key_only') return 'confirmed_none'
		return 'unknown'
	}
	if (input.ws === 'no_key') {
		// (PNK-01..05) supersedes for kPresent true: only kPresent false is confirmed none. kPresent true is the native key
		// held (recovery entry only, never none, never retried as unknown here); kPresent missing or not a boolean is unknown.
		return input.kPresent === false ? 'confirmed_none' : 'unknown'
	}
	return 'unknown'
}

/**
 * Onboarding is entered only when the IDB side and the native side are both confirmed_none (#3(c)).
 * Any unknown is retry_unknown: no onboarding and no deletion. Either side has an account: keep it.
 */
export function onboardingAllowed(idb: NativePresence, native: NativePresence): boolean {
	return idb === 'confirmed_none' && native === 'confirmed_none'
}

/**
 * IndexedDB side. A key on the record is present; an empty store is confirmed none. Any other read state
 * (locked, unavailable, unfinished, a record without a key, a corrupt record) is unknown.
 */
export function idbPresenceOf(signal: IdbSignal): NativePresence {
	// and 3: a readable mnemonic is has. A successful read with no mnemonic (an empty store, or an account record without a key)
	// is confirmed none; residues (PGP, history, phase, COMMIT, INTENT, MARK, digest) never block it.
	if (signal === 'valid_mnemonic') return 'has'
	if (signal === 'absent' || signal === 'account_without_key') return 'confirmed_none'
	//a real read error, a lock, not ready, or an entry that cannot be parsed or decrypted is unknown (retry).
	return 'unknown'
}

/**
 * Native side. `native` is the walletStatus answer; `kPresent` is the identityPublic kPresent of a no_key answer, read by
 * the caller.
 */
export function nativePresenceOfState(native: NativeWalletStatusAnswer, kPresent: boolean | undefined): NativePresence {
	if (native.status === 'locked' || native.status === 'unlocked') return nativePresence({ ws: native.status, snapshotUnknown: false })
	if (native.status === 'not_ready') return nativePresence({ ws: 'not_ready', reason: native.notReadyReason, snapshotUnknown: false })
	if (native.status === 'no_key') return nativePresence({ ws: 'no_key', kPresent, snapshotUnknown: false })
	return nativePresence({ ws: 'unknown', snapshotUnknown: true })
}

/** The walletStatus answer shape the presence reads (queryNativeWalletStatus). Structural, so no native module is imported. */
export type NativeWalletStatusAnswer =
	| { status: 'no_key' | 'unknown' }
	| { status: 'not_ready'; notReadyReason?: 'g1_uninitialized' | 'key_only' | 'unreadable' }
	| { status: 'locked' | 'unlocked' | 'phrase_only'; eoa: string }

/**
 * account-reset state machine (r3rz). Order: (a) any unknown, a lock or a timeout is retry_unknown (no onboarding, no deletion);
 * (b) either side has an account: continue_account; (c) both sides confirmed none: cleanup_old only when the user has confirmed the
 * recovery and the new account is established, otherwise onboarding. Entering onboarding deletes nothing.
 */
export type AccountResetInput = {
	idb: NativePresence
	native: NativePresence
	locked?: boolean
	timeout?: boolean
	userConfirmedRecovery: boolean
	newAccountEstablished: boolean
}
export type AccountResetDecision = 'retry_unknown' | 'continue_account' | 'onboarding' | 'cleanup_old'

export function decideAccountReset(input: AccountResetInput): AccountResetDecision {
	if (input.locked || input.timeout || input.idb === 'unknown' || input.native === 'unknown') return 'retry_unknown'
	if (input.idb === 'has' || input.native === 'has') return 'continue_account'
	if (input.userConfirmedRecovery && input.newAccountEstablished) return 'cleanup_old'
	return 'onboarding'
}

/**
 *which side of the no-record entry a shell may consult, by the capabilities it reports.
 * - `browser`: no native side.
 * - `legacy_shell`: a shell that does not report identity.native-keys.v1: IndexedDB only, the single compatibility exception.
 * - `native_no_kpresent`: native-keys reported, identity.kpresent.v1 not reported: the native side is unknown; no creation entry.
 * - `native_full`: both reported: the two-sided judgement of and.
 */
export type ShellTier = 'browser' | 'legacy_shell' | 'native_no_kpresent' | 'native_full'

export function shellTierOf(input: { shell: boolean; nativeKeys: boolean; kpresent: boolean }): ShellTier {
	if (!input.shell) return 'browser'
	if (!input.nativeKeys) return 'legacy_shell'
	return input.kpresent ? 'native_full' : 'native_no_kpresent'
}

/**
 * The walletStatus answer shape. The `status` key is the walletState of the answer: when it is missing the answer
 * is malformed and is unknown, never has (so a locked answer without its status key is not a basis for an account). Only a present
 * `locked` or `unlocked` with a valid account key (`eoa:workspace`) is has. `isAddress` checks the EOA (the caller passes ethers).
 */
export function parseWalletStatusResult(result: unknown, isAddress: (value: string) => boolean): NativeWalletStatusAnswer {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return { status: 'unknown' }
	const r = result as { status?: unknown; accountKey?: unknown; notReadyReason?: unknown }
	const st = r.status
	if (st === 'no_key') return { status: 'no_key' }
	// `notReadyReason` is read only on a not_ready answer. An unknown reason, or none, is normalised to unreadable.
	if (st === 'not_ready') {
		const reason = r.notReadyReason
		return {
			status: 'not_ready',
			notReadyReason: reason === 'g1_uninitialized' || reason === 'key_only' || reason === 'unreadable' ? reason : 'unreadable',
		}
	}
	if (st === 'phrase_only') {
		const key = typeof r.accountKey === 'string' ? r.accountKey : ''
		const eoa = key.split(':')[0]?.trim() ?? ''
		return isAddress(eoa) ? { status: 'phrase_only', eoa: eoa.toLowerCase() } : { status: 'unknown' }
	}
	if (st === 'locked' || st === 'unlocked') {
		const key = typeof r.accountKey === 'string' ? r.accountKey : ''
		const eoa = key.split(':')[0]?.trim() ?? ''
		return isAddress(eoa) ? { status: st, eoa: eoa.toLowerCase() } : { status: 'unknown' }
	}
	// a missing or unrecognised status key: the answer is malformed, so unknown (never has, never confirmed none).
	return { status: 'unknown' }
}
