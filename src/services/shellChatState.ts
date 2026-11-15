/**
 * Shell and capability state of the chat.
 *
 * - The shell is decided by the build (`buildKind = shell`) or by the native bridge. A shell never enters the
 *   page-key path, even when the bridge is missing.
 * - `identity.native-keys.v1` decides whether the native chat starts. `identity.route-register.native.v1` decides whether
 *   registration runs natively. The two are judged separately.
 * - Without `identity.native-keys.v1` in a shell, nothing is sent and the UI shows the unified unavailable state (option A).
 *
 * Pure: the bridge and the hello capabilities are passed in. The decision table is pinned by
 * the shared route-decision vectors.
 */

export const NATIVE_KEYS_CAPABILITY = 'identity.native-keys.v1'
export const ROUTE_REGISTER_CAPABILITY = 'identity.route-register.native.v1'

export type BuildKind = 'web' | 'shell'
export type ChatMode = 'browser' | 'native' | 'unavailable'
export type RouteRegisterPath = 'page_signing_browser_exception' | 'native_chatRouteRegister' | 'native_unavailable_no_fallback'
export type PayloadSent = 'page_only' | 'public_fields_only' | 'none'
export type UiState = 'browser_chat' | 'native_chat' | 'chat_unavailable'

export type ShellInput = {
	buildKind: BuildKind
	/** True when the native chat bridge object is present. */
	bridge: boolean
	/** Capabilities from the `hello` answer. Empty when there is no answer. */
	caps: readonly string[]
}

export type ShellState = {
	chatMode: ChatMode
	nativeChatStarted: boolean
	pageHoldsKey: boolean
	routeRegisterPath: RouteRegisterPath
	payloadSent: PayloadSent
	uiState: UiState
}

/**  and: a shell is a shell build, or a page with the native bridge. */
export function isShell(input: Pick<ShellInput, 'buildKind' | 'bridge'>): boolean {
	return input.buildKind === 'shell' || input.bridge
}

export function decideShellState(input: ShellInput): ShellState {
	const shell = isShell(input)
	const caps = new Set(input.caps)
	if (!shell) {
		return {
			chatMode: 'browser',
			nativeChatStarted: false,
			pageHoldsKey: true,
			routeRegisterPath: 'page_signing_browser_exception',
			payloadSent: 'page_only',
			uiState: 'browser_chat',
		}
	}
	// A shell with the bridge and `identity.native-keys.v1` starts the native chat. Without the bridge, or without the
	// capability, the chat is unavailable and nothing is sent. The page never holds the key in a shell.
	const nativeChat = input.bridge && caps.has(NATIVE_KEYS_CAPABILITY)
	const routeNative = nativeChat && caps.has(ROUTE_REGISTER_CAPABILITY)
	return {
		chatMode: nativeChat ? 'native' : 'unavailable',
		nativeChatStarted: nativeChat,
		pageHoldsKey: false,
		routeRegisterPath: routeNative ? 'native_chatRouteRegister' : 'native_unavailable_no_fallback',
		payloadSent: nativeChat ? 'public_fields_only' : 'none',
		uiState: nativeChat ? 'native_chat' : 'chat_unavailable',
	}
}
