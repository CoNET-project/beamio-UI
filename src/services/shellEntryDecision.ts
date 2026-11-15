/**
 * Entry decision for a native shell that may lack `identity.native-keys.v1` (option A).
 *
 * - A shell that did not answer `hello` is `unanswered`: the existing native-status path decides, as before.
 * - A shell that answered without the capability is `missing`. Its chat is unavailable (the unified state, existing copy), nothing
 *   identity-bearing is sent, and the page never holds a key. It is not the not-ready state and not G0, so it does not reach the
 *   page-wallet path, not even for `no_key`. A native account that is already locked or unlocked still enters the app on its public
 *   address, so the other wallet features stay usable; the chat route shows the unavailable state.
 *
 * Pure: the probe answer and the native status are passed in.
 */
import type { NativeWalletState } from './nativeRecovery'
import { NATIVE_KEYS_CAPABILITY } from './shellChatState'

export type IdentityCapabilityState = 'declared' | 'missing' | 'unanswered'

/** The capability state from a capability probe (`probeNativeCapabilities`). */
export function identityCapabilityFrom(probe: { answered: boolean; capabilities: readonly string[] }): IdentityCapabilityState {
	if (!probe.answered) return 'unanswered'
	return probe.capabilities.includes(NATIVE_KEYS_CAPABILITY) ? 'declared' : 'missing'
}

/**
 * - `native_status`: the existing path (the native status decides, including the not-ready screen).
 * - `enter_native`: an account is known to the native layer (locked or unlocked): enter the app on its public address.
 * - `chat_unavailable`: the shell lacks the capability and no account is known: show the unified unavailable state.
 */
export type ShellEntry = 'native_status' | 'enter_native' | 'chat_unavailable'

export function shellEntryFor(identity: IdentityCapabilityState, native: NativeWalletState): ShellEntry {
	if (identity !== 'missing') return 'native_status'
	if (native.status === 'locked' || native.status === 'unlocked') return 'enter_native'
	return 'chat_unavailable'
}
