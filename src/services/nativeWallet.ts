/**
 * Shell wallet entry on public identity only. The native layer holds the keys. The page knows the account
 * address (public) and the BeamioTag the user restored with (public), and nothing else. Neither is stored as wallet state.
 */
import { persistShellEoa, readPersistedShellEoa } from './shellIdentitySource'
import { queryNativeWalletStatus, type NativeWalletState } from './nativeRecovery'
import { forgetInitRefusal, initShellIdentityOnly } from './chatWorkerBridge'
import { probeNativeCapabilities } from './nativeChatRouteRegister'
import { identityCapabilityFrom, nativeInitAllowed } from './shellEntryDecision'
import { readNodeListForInit } from './coNETNodeRead'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'
import { isIosNativeShell } from './nativeIosShell'
import { deviceCachedBeamioTagFor, rememberDeviceBeamioTag } from '@/utils/accountNameGuard'

/** Fired after a native recovery succeeds: the app re-reads the native wallet state and enters the app (no reload). */
export const NATIVE_WALLET_READY_EVENT = 'beamio:native-wallet-ready'

/** The in-memory profile for a shell wallet: the public address and, if known, the account name. No secret field. */
export function publicWalletSeed(eoa: string): encrypt_keys_object {
	const name = deviceCachedBeamioTagFor(eoa)
	const profile = {
		keyID: eoa,
		isPrimary: true,
		referrer: null,
		isNode: false,
		type: 'ethereum',
		webFilter: true,
		tokens: [],
	}
	return {
		profiles: [profile],
		beamio: name ? { accountName: name } : undefined,
		isReady: true,
		ver: 0,
		nonce: 0,
	} as unknown as encrypt_keys_object
}

/** The account address from the last native result (public). Used once to run the native init when the wallet is not ready. */
let nativeEoaHint: string | null = null

/**
 * Keeps the public address of the native account in the shell identity source: a restart needs it for the
 * one native init of a not-ready (G1) wallet. The address is public; the store holds nothing else.
 */
export function rememberNativeEoa(eoa: string | undefined | null): void {
	if (typeof eoa !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(eoa)) return
	nativeEoaHint = eoa.toLowerCase()
	persistShellEoa(nativeEoaHint)
}

function persistedNativeEoa(): string | null {
	return readPersistedShellEoa() || null
}

/** The last refusal of the G1 identity-only init : an address mismatch leaves the local home). Read once. */
let lastInitRefusal: string | null = null
/**
 * HC-LOCK INIT-3/INIT-4 (v10 §12.3): an init answered locked holds further inits until the unlock (passcodeState{locked:false}, R-21).
 * While held, no init is sent (the count stays at one). The unlock releases the hold once: the next reach may send one more init.
 */
let initLockedHold = false
export function releaseInitLockedHold(): void {
	initLockedHold = false
}
/** A refusal reason that names the native lock (`locked`), not `unlocked` or another reason. */
export function isLockedInitReason(reason: string): boolean {
	return /\blocked\b/.test(reason)
}
export function takeInitRefusal(): string | null {
	const reason = lastInitRefusal
	lastInitRefusal = null
	return reason
}

/**
 * The native wallet reaches G2: walletStatus locked or unlocked, with a public account key.
 * A wallet that is not ready (G1) gets one native init on the public address, then is asked again.
 */
export async function reachNativeWallet(): Promise<NativeWalletState> {
	let state = await queryNativeWalletStatus()
	const hint = nativeEoaHint ?? persistedNativeEoa()
	// Y.75 / Y.39 #7: init only when the native layer proves the record is uninitialized. A not_ready with unreadable
	// (or no reason) never sends an init on the browser or Android side: it is undetermined.
	// Y.163 (iOS only): a not_ready with unreadable sends ONE init on this device's public address; the native init picks the first
	// readable wallet by itself and never creates one. Still unreadable after it: the retry state (no picker, nothing created).
	const iosUnreadableInit = state.status === 'not_ready' && state.notReadyReason === 'unreadable' && isIosNativeShell()
	if (!initLockedHold && ((state.status === 'not_ready' && state.notReadyReason === 'g1_uninitialized') || iosUnreadableInit) && hint) {
		// The identity-capability rule: an init carries identity. Without the declared capability nothing identity-bearing is sent.
		const identity = identityCapabilityFrom(await probeNativeCapabilities())
		if (!nativeInitAllowed(identity)) {
			lastInitRefusal = null
			publishNativePwaLog('info', '[nativeWallet] init not sent: identity.native-keys.v1 not confirmed (no identity payload)')
			return state
		}
		// G1: the EOA only (): no route key, no PGP key, no provisionIdentity. The native layer checks the EOA.
		// The node list is read fresh; an empty or unavailable list is omitted from the init, never sent as [].
		const nodes = await readNodeListForInit()
		const sent = await initShellIdentityOnly(hint, nodes)
		lastInitRefusal = sent.ok ? null : sent.reason
		if (!sent.ok && isLockedInitReason(sent.reason)) initLockedHold = true
		publishNativePwaLog(
			'info',
			`[nativeWallet] init to G2 ${sent.ok ? 'sent' : `not accepted: ${sent.reason}`} (node list ${nodes.length ? 'sent' : 'omitted'})`,
		)
		state = await queryNativeWalletStatus()
	}
	return state
}

/** `tag` and `eoa` are the account the native wallet was created or restored for; the name is cached only with its EOA. */
export function notifyNativeWalletReady(tag?: string, eoa?: string): void {
	rememberDeviceBeamioTag(tag, eoa)
	// a native wallet that became ready may now hold the account the chat was refused for.
	forgetInitRefusal()
	window.dispatchEvent(new Event(NATIVE_WALLET_READY_EVENT))
}
