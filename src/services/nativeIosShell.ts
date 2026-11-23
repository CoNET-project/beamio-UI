/** Y.163: the iOS native shell (the WebKit bridge), and not Android. Kept apart from nativeWallet so a mocked wallet module keeps it. */
export function isIosNativeShell(): boolean {
	if (typeof window === 'undefined') return false
	const w = window as Window & { CashTreesIOS?: unknown; CashTreesAndroid?: unknown; webkit?: { messageHandlers?: Record<string, unknown> } }
	if (w.CashTreesAndroid) return false
	return !!w.CashTreesIOS || !!w.webkit?.messageHandlers?.CashTreesIOS
}
