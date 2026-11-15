/**
 * a native account creation or restore that reports ok establishes the wallet at once. The
 * event is dispatched synchronously in the same tick as the ok answer, before any async read, so the entry gate can refuse a
 * late no_key from that moment on.
 */
export const NATIVE_WALLET_ESTABLISHED_EVENT = 'beamio:native-wallet-established'

export function announceNativeWalletEstablished(): void {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new CustomEvent(NATIVE_WALLET_ESTABLISHED_EVENT))
}
