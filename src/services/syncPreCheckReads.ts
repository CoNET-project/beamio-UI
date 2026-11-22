/**
 * The native reads of the C1 pre-sync check (walletState and walletStatus), in one place. The gate calls these through runSyncPreCheck.
 */
import { readNativeWalletStatus, type NativeWalletStatus } from './nativeKeyState'
import { queryNativeWalletState } from './nativeRecovery'
import type { PreCheckWalletState, PreCheckWalletStatus } from './syncPreCheck'

export async function queryNativeWalletStateForPreCheck(): Promise<PreCheckWalletState> {
	return queryNativeWalletState()
}

export async function queryNativeWalletStatusForPreCheck(): Promise<PreCheckWalletStatus> {
	const st: NativeWalletStatus = await readNativeWalletStatus()
	return st as PreCheckWalletStatus
}
