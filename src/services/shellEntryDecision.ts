/**
 * Entry decision for a native shell that may lack `identity.native-keys.v1` (option A).
 *
 * - A shell that did not answer `hello` is `unanswered`: the existing native-status path decides, as before.
 * - A shell that answered without the capability is `missing`. Its chat is unavailable (the unified state, existing copy), nothing
 * identity-bearing is sent, and the page never holds a key. It is not the not-ready state and not G0, so it does not reach the
 * page-wallet path, not even for `no_key`. A native account that is already locked or unlocked still enters the app on its public
 * address, so the other wallet features stay usable; the chat route shows the unavailable state.
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
	if (identity === 'declared') return 'native_status'
	if (native.status === 'unlocked') return 'enter_native'
	return 'chat_unavailable'
}

/**
 * An init is an identity payload (the G1 account key route). It is sent only when the shell declared identity.native-keys.v1
 *; a missing capability sends nothing. An unanswered hello keeps the existing path.
 */
export function nativeInitAllowed(identity: IdentityCapabilityState): boolean {
	return identity === 'declared'
}

/** The retry screen for a native that did not answer its capability probe and has no known public address. */
export const NATIVE_RETRY_SCREEN = 'native_not_ready_retry'
/** Storage not readable yet and no page copy: shown after the bounded native wait, never as "no account" (r3rz). */
export const MIGRATION_RETRY_SCREEN = 'migration_retry'

/**
 * Capability missing and the native wallet not ready: the local home when this device holds a public address, else the unified
 * unavailable state. Never the recovery or import page, and never a lock page.
 */
export function missingIdentityNotReadyEntry(eoaKnown: boolean): 'local_home' | 'unified_unavailable' {
	return eoaKnown ? 'local_home' : 'unified_unavailable'
}

/**
 * CAP display rule (PWA, 2026-11-17 rule; account-select CAP-01/02/05/06/07). The identity entry shows the unified "unavailable" state only
 * when the capability is missing AND the native side explicitly answers no key (absent is the same as no_key, 58(2)(e)). An unanswered or
 * not-ready native shows no unified state (`none`): the start stays in its startup state. A declared capability never shows it. This is a
 * display rule only; it does not route (CAP-04/07: a valid PWA mnemonic still goes to the home).
 */
export type IdentityEntryDisplay = 'unified_unavailable' | 'none'

export function identityEntryDisplay(identity: IdentityCapabilityState, native: NativeWalletState): IdentityEntryDisplay {
	if (identity !== 'missing') return 'none'
	return native.status === 'no_key' ? 'unified_unavailable' : 'none'
}
