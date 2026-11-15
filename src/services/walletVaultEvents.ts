/** Window event: the wallet passcode layer was locked by sign-out. AppEntryGate shows the passcode screen. */
export const VAULT_LOCKED_EVENT = 'beamio:vault-locked'

/**
 * Window event: the passcode was turned on, or turned off or removed (wipe). Listeners re-read `walletVaultHasPasscode()`.
 * The sign-out entry ("Lock") is shown only while a passcode is on, so it appears and disappears at once.
 */
export const PASSCODE_STATE_EVENT = 'beamio:passcode-state'

/** Dispatches PASSCODE_STATE_EVENT. No-op outside a browser (tests and workers). */
export function notifyPasscodeStateChanged(): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new Event(PASSCODE_STATE_EVENT))
}
