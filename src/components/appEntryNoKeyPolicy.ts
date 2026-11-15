/**
 * Boundary: the native no-key signal shows the import
 * route only when the entry gate has decided, no wallet has been established (page account, native wallet, or a wallet-ready
 * event after creation or restore), and the page store was read successfully and is empty. The flags are live: a creation
 * that succeeds in the session turns a late no_key into a no-op. A storage that could not be read never gets the import route.
 */
export type NoKeyPolicyState = {
	/** The entry gate has made its decision. */
	gateDecided: boolean
	/** A wallet is established now (page account, native wallet, or a wallet-ready event after creation or restore). */
	walletEstablished: boolean
	/** The page storage was read successfully and holds no account (first-time onboarding). */
	storageConfirmedEmpty: boolean
	/** A native create or recovery page is open (opened, and not yet ok, cancelled or unmounted). */
	nativeFlowOpen?: boolean
}

export function nativeNoKeyTakesOver(s: NoKeyPolicyState): boolean {
	return s.gateDecided && !s.walletEstablished && s.storageConfirmedEmpty && !s.nativeFlowOpen
}
