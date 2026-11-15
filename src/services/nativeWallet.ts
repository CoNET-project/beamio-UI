/**
 * Shell wallet entry on public identity only. The native layer holds the keys. The page knows the account
 * address (public) and the BeamioTag the user restored with (public), and nothing else. Neither is stored as wallet state.
 */
import { persistShellEoa, readPersistedShellEoa } from './shellIdentitySource'
import { queryNativeWalletStatus, type NativeWalletState } from './nativeRecovery'
import { forgetInitRefusal, initShellIdentityOnly } from './chatWorkerBridge'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

/** Fired after a native recovery succeeds: the app re-reads the native wallet state and enters the app (no reload). */
export const NATIVE_WALLET_READY_EVENT = 'beamio:native-wallet-ready'

const ACCOUNT_NAME_KEY = 'beamio.shellAccountName'

/** The BeamioTag the user restored with (public, not key material). Used only to name the account in the shell. */
export function rememberShellAccountName(tag: string | undefined | null): void {
	const name = (tag ?? '').trim().replace(/^@+/, '')
	if (!name) return
	try {
		window.localStorage.setItem(ACCOUNT_NAME_KEY, name)
	} catch {
		// private mode or storage disabled: the account simply has no name in the shell
	}
}

export function shellAccountName(): string {
	try {
		return window.localStorage.getItem(ACCOUNT_NAME_KEY)?.trim() ?? ''
	} catch {
		return ''
	}
}

/** The in-memory profile for a shell wallet: the public address and, if known, the account name. No secret field. */
export function publicWalletSeed(eoa: string): encrypt_keys_object {
	const name = shellAccountName()
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

/**
 * The native wallet reaches G2: walletStatus locked or unlocked, with a public account key.
 * A wallet that is not ready (G1) gets one native init on the public address, then is asked again.
 */
export async function reachNativeWallet(): Promise<NativeWalletState> {
	let state = await queryNativeWalletStatus()
	const hint = nativeEoaHint ?? persistedNativeEoa()
	if (state.status === 'not_ready' && hint) {
		// G1: the EOA only (bc5303be): no route key, no PGP key, no provisionIdentity. The native layer checks the EOA.
		const started = (await initShellIdentityOnly(hint, [])).ok
		publishNativePwaLog('info', `[nativeWallet] init to G2 ${started ? 'sent' : 'not started (native module)'}`)
		state = await queryNativeWalletStatus()
	}
	return state
}

export function notifyNativeWalletReady(tag?: string): void {
	rememberShellAccountName(tag)
	// a native wallet that became ready may now hold the account the chat was refused for.
	forgetInitRefusal()
	window.dispatchEvent(new Event(NATIVE_WALLET_READY_EVENT))
}
