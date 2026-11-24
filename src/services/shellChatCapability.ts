/**
 * Option A: inside a native shell without `identity.native-keys.v1`,
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
import { onHelloValid, probeNativeCapabilities } from './nativeChatRouteRegister'
import { identityCapabilityFrom } from './shellEntryDecision'
import { setNativeIdentityCapability, getNativeIdentityCapability } from './nativeIdentityProbeRetry'
import { tu } from '@/locale/beamioLocale'
import { notifyIdentityEntryBlocked } from './identityEntryPrompt'
import { decideShellState, type UiState } from './shellChatState'
import { getShellChatUiState, setShellChatUiState } from './shellChatUiState'

export { isShellContext }

/** The rule of option A as a pure check: a shell blocks identity paths unless its state is `native_chat`. */
export function shellChatBlocked(input: { shell: boolean; state: UiState }): boolean {
	return input.shell && input.state !== 'native_chat'
}

/** Synchronous check for identity paths. Fails closed in a shell until the capability answer is recorded. */
export function shellChatBlockedNow(): boolean {
	const blocked = shellChatBlocked({ shell: isShellContext(), state: getShellChatUiState() })
	// the one guard every identity entry calls: a blocked check after a tap raises the shared prompt
	if (blocked) notifyIdentityEntryBlocked()
	return blocked
}

/**
 * The text a blocked feature entry shows. "Please update" is only for a valid hello that lacks the capability (missing); while there is no valid
 * answer yet (unanswered, unknown) the native side is still getting ready, so the entry says that and a retry later is fine
 * (a late answer is not a failure).
 */
export function shellChatBlockedText(): string {
	return tu(getNativeIdentityCapability() === 'missing' ? 'shell_chat_unavailable_body' : 'native_preparing_wallet')
}

/** Pure resolution from the build flag, the bridge and the hello capabilities. */
export function resolveShellChatState(input: { buildKind: 'web' | 'shell'; bridge: boolean; caps: readonly string[] }): UiState {
	return decideShellState(input).uiState
}

let pending: Promise<UiState> | null = null

/** Called when a VALID hello answer settles the chat state (a late answer included). chat.ts starts the chat from it. */
const resolvedListeners = new Set<(state: UiState) => void>()
export function onShellChatCapabilityResolved(cb: (state: UiState) => void): () => void {
	resolvedListeners.add(cb)
	return () => {
		resolvedListeners.delete(cb)
	}
}
let lateHelloHooked = false
/** Test-only: forgets the resolved state so a case starts from the first ask. */
export function resetShellChatCapabilityForTest(): void {
	pending = null
	resolvedListeners.clear()
	lateHelloHooked = false
}
/**
 * A valid hello at any time (on time or late) settles the state: the capability status, the chat state, and whoever waits (the chat start).
 * "Not answered" never produced a missing capability; only a valid answer without it does. A shown "unavailable" is withdrawn by a valid
 * answer that has the capability (no click needed).
 */
function hookLateHello(): void {
	if (lateHelloHooked) return
	lateHelloHooked = true
	onHelloValid((r) => {
		const shellBuild = isShellBuildKind()
		const bridge = isCashTreesNativeWebView()
		if (!shellBuild && !bridge) return
		const state = resolveShellChatState({ buildKind: shellBuild ? 'shell' : 'web', bridge, caps: r.capabilities })
		setNativeIdentityCapability(identityCapabilityFrom(r))
		setShellChatUiState(state)
		pending = Promise.resolve(state)
		for (const cb of [...resolvedListeners]) cb(state)
	})
}

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
	hookLateHello()
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
