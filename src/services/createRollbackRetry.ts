/**
 * OB-3 on the create page. The rule for the create page, applied here on purpose:
 * - reason must be rollback_pending (the held write of the create);
 * - the live reread of walletEoaAddress must be valid or absent (PWA-RETRY-03);
 * - the live walletStatus must not be locked: while the rollback is not settled, walletStatus is locked and the button stays hidden;
 * once it is settled the button shows (interface review, 2026-11-18).
 * Deviation (for review): the create page writes no persistent held-write record, so the conditions hasRecord and accountMatches are
 * not judged here. Nothing is fabricated: only the three live inputs above are read.
 * The button starts a new nativeAccountCreateOpen; it does not resend the held write. The native open is idempotent (interface review:
 * Android NativeWalletVault.kt:439, NativeOpenRules.kt:139–147, AccountCreateGuard.kt:50–52, NativeAccountCreate.kt:257; iOS nativeGate()==.g0).
 */
import { rereadDecision, type RereadAnswer } from './manualRetryReread'

/** The walletStatus values that show the button: only no_key or unlocked. */
export const CREATE_RETRY_NATIVE_STATUSES: readonly string[] = ['no_key', 'unlocked']

export function createRollbackRetryVisible(input: { reason: string | undefined; reread: RereadAnswer; nativeStatus: string }): boolean {
	return input.reason === 'rollback_pending' && rereadDecision(input.reread) === 'send' && CREATE_RETRY_NATIVE_STATUSES.includes(input.nativeStatus)
}
