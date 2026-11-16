/**
 * Native account presence (Y.89, TS-01 to TS-06). Three answers from the walletStatus and identityPublic state the
 * native layer already gives: has (keep the account), confirmed_none (both sides confirmed no wallet), unknown (retry, never
 * onboarding, never a deletion). No extra command.
 */
import type { IdbSignal } from './accountJudgement'

export type NativePresence = 'has' | 'confirmed_none' | 'unknown'

export type NativePresenceInput = {
	/** walletStatus status, or 'unknown' when the snapshot is not known. */
	ws: 'unlocked' | 'locked' | 'not_ready' | 'no_key' | 'unknown'
	/** walletStatus notReadyReason, read only on not_ready. */
	reason?: 'g1_uninitialized' | 'unreadable'
	/** identityPublic kPresent: true, false, or absent (undefined). */
	kPresent?: boolean
	/** The snapshot is not known (native answered not_ready for an unknown snapshot). */
	snapshotUnknown: boolean
}

export function nativePresence(input: NativePresenceInput): NativePresence {
	// TS-05: an unknown snapshot is never a basis for a decision.
	if (input.snapshotUnknown) return 'unknown'
	// TS-03: an unlocked or locked wallet (with its account key) is present.
	if (input.ws === 'unlocked' || input.ws === 'locked') return 'has'
	if (input.ws === 'not_ready') {
		// TS-02: an uninitialised record (G1) is present. TS-04: unreadable, or no reason, is unknown.
		return input.reason === 'g1_uninitialized' ? 'has' : 'unknown'
	}
	if (input.ws === 'no_key') {
		// TS-01: confirmed none only when identityPublic says kPresent is false. TS-06: kPresent true or absent is unknown.
		return input.kPresent === false ? 'confirmed_none' : 'unknown'
	}
	return 'unknown'
}

/**
 * Onboarding is entered only when the IDB side and the native side are both confirmed_none (Y.85 #3(c)).
 * Any unknown is retry_unknown: no onboarding and no deletion. Either side has an account: keep it.
 */
export function onboardingAllowed(idb: NativePresence, native: NativePresence): boolean {
	return idb === 'confirmed_none' && native === 'confirmed_none'
}

/**
 * IndexedDB side (Y.85 input `idb`). A key on the record is present; an empty store is confirmed none. Any other read state
 * (locked, unavailable, unfinished, a record without a key, a corrupt record) is unknown.
 */
export function idbPresenceOf(signal: IdbSignal): NativePresence {
	if (signal === 'key') return 'has'
	if (signal === 'absent') return 'confirmed_none'
	return 'unknown'
}

/**
 * Native side (Y.89). `native` is the walletStatus answer; `kPresent` is the identityPublic kPresent of a no_key answer, read by
 * the caller (undefined when the capability identity.kpresent.v1 is not declared, which is unknown, Y.90 4).
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
	| { status: 'not_ready'; notReadyReason?: 'g1_uninitialized' | 'unreadable' }
	| { status: 'locked' | 'unlocked'; eoa: string }

/**
 * Y.85 account-reset state machine (r3rz). Order: (a) any unknown, a lock or a timeout is retry_unknown (no onboarding, no deletion);
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
