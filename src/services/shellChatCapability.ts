/**
 * Option A (spec, accepted by the project 2026-11-13): inside a native shell without `identity.native-keys.v1`,
 * nothing identity-bearing is sent, the page does not hold the key, and there is no fallback. The chat shows the unified
 * unavailable state.
 *
 * - `ensureShellChatState` asks the shell once (`hello`) and records the result in the UI store. A shell that has not
 *   answered yet is treated as unavailable (fail closed); a browser is `browser_chat` at once.
 * - `shellChatBlockedNow` is the synchronous check the identity paths call before they read a key or send a command. It is
 *   true inside a shell unless the shell has declared the chat capability.
 */
import { isShellBuildKind } from '../utils/shellBuildFlag'
import { isCashTreesNativeWebView } from '../utils/cashTreesNativeNfc'
import { isShellContext } from './shellContext'
import { probeNativeCapabilities } from './nativeChatRouteRegister'
import { decideShellState, type UiState } from './shellChatState'
import { getShellChatUiState, setShellChatUiState } from './shellChatUiState'

export { isShellContext }

/** The rule of option A as a pure check: a shell blocks identity paths unless its state is `native_chat`. */
export function shellChatBlocked(input: { shell: boolean; state: UiState }): boolean {
	return input.shell && input.state !== 'native_chat'
}

/** Synchronous check for identity paths. Fails closed in a shell until the capability answer is recorded. */
export function shellChatBlockedNow(): boolean {
	return shellChatBlocked({ shell: isShellContext(), state: getShellChatUiState() })
}

/** Pure resolution from the build flag, the bridge and the hello capabilities. */
export function resolveShellChatState(input: { buildKind: 'web' | 'shell'; bridge: boolean; caps: readonly string[] }): UiState {
	return decideShellState(input).uiState
}

let pending: Promise<UiState> | null = null

/**
 * Resolves the shell chat state once per page load when the shell has answered; otherwise the next call asks again, so a
 * slow start does not leave the chat blocked for the whole session.
 */
export function ensureShellChatState(): Promise<UiState> {
	if (pending) return pending
	const shellBuild = isShellBuildKind()
	const bridge = isCashTreesNativeWebView()
	if (!shellBuild && !bridge) {
		setShellChatUiState('browser_chat')
		return Promise.resolve('browser_chat')
	}
	setShellChatUiState('chat_unavailable')
	const attempt = (async (): Promise<UiState> => {
		const probe = bridge ? await probeNativeCapabilities() : { answered: false, capabilities: [] as string[] }
		const state = resolveShellChatState({ buildKind: shellBuild ? 'shell' : 'web', bridge, caps: probe.capabilities })
		setShellChatUiState(state)
		// Keep the answer for the page load only when the shell answered, or when there is no bridge to ask.
		if (!bridge || probe.answered) return state
		pending = null
		return state
	})()
	pending = attempt
	return attempt
}
