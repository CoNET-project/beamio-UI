/**
 * C1: before an automatic page-to-shell sync, the page reads the native walletState (passcodeStatus) and walletStatus.
 * An automatic sync is not sent when walletState is locked, corrupt, unknown or timed out, or when walletStatus is locked, unknown or
 * timed out (ok or envelope). Such a sync is held as pending (pendingSync) and resumed once on the unlock. A manual retry is not this path.
 */
import type { NativeWalletState } from './accountJudgement'

/** The walletStatus values the decision reads (readNativeWalletStatus). `timeout` is the caller's answer for no reply. */
export type PreCheckWalletStatus = 'no_key' | 'not_ready' | 'locked' | 'unlocked' | 'unknown' | 'unavailable' | 'timeout'
/** The walletState values the decision reads (queryNativeWalletState); `timeout` for no reply. */
export type PreCheckWalletState = NativeWalletState | 'not_reported' | 'timeout'

export type SyncPreCheck = 'sync' | 'pending'

/** Pure decision (C1). `pending` means: do not send now, hold it for the unlock. */
export function syncPreCheckDecision(input: { walletState: PreCheckWalletState; walletStatus: PreCheckWalletStatus }): SyncPreCheck {
	const ws = input.walletState
	if (ws === 'locked' || ws === 'corrupt' || ws === 'unknown' || ws === 'timeout') return 'pending'
	const st = input.walletStatus
	if (st === 'locked' || st === 'unknown' || st === 'unavailable' || st === 'timeout') return 'pending'
	return 'sync'
}

/**
 * The reads of the pre-check (walletState and walletStatus), then the decision. The reads live here, not in the gate, so the gate keeps
 * reading no walletStatus of its own (the recovery route rule). A read that throws is a timeout.
 */
export async function runSyncPreCheck(
	readState: () => Promise<PreCheckWalletState>,
	readStatus: () => Promise<PreCheckWalletStatus>,
): Promise<SyncPreCheck> {
	const walletState = await readState().catch((): PreCheckWalletState => 'timeout')
	const walletStatus = await readStatus().catch((): PreCheckWalletStatus => 'timeout')
	return syncPreCheckDecision({ walletState, walletStatus })
}
