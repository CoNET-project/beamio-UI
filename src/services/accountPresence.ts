/**
 * Native account presence (Y.89, TS-01 to TS-06). Three answers from the walletStatus and identityPublic state the
 * native layer already gives: has (keep the account), confirmed_none (both sides confirmed no wallet), unknown (retry, never
 * onboarding, never a deletion). No extra command.
 */
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
