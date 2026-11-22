/**
 * UI lock report and the step after a UI unlock (
 * not involved here). Pure: the send function is injected; nothing here reads or writes secrets.
 *
 * - The page reports only `uiLockState {locked:true}` when it shows its UI lock (any UI lock, including the hot-restore lock).
 * The page never sends `locked:false`: the SDK sets `uiUnlocked` true only on a successful `passcodeUnlock`.
 * - After a UI unlock: when the native session is already unlocked the page does NOT send `passcodeUnlock`; it runs
 * `nativeIdentityCheck {eoa}` instead. When the native session is locked, the page sends `passcodeUnlock`.
 */
import { passcodeCapabilityDeclared } from './passcodeCommands'

export const UI_LOCK_STATE_COMMAND = 'uiLockState'

/** The only `uiLockState` the page sends. Fixed body, no other field. */
export const UI_LOCKED_COMMAND = { type: UI_LOCK_STATE_COMMAND, locked: true } as const

export type UiLockReportOutcome = { kind: 'sent' } | { kind: 'refused'; reason: 'capability_missing' } | { kind: 'failed' }

/**
 * Reports the page's UI lock to the shell. Refused when the shell did not declare the passcode capability (fail closed).
 * A failed or refused report is never retried in a loop here: the next UI lock sends it again.
 */
export async function reportUiLocked(
	declared: readonly string[],
	send: (cmd: Record<string, unknown>) => Promise<unknown>,
): Promise<UiLockReportOutcome> {
	if (!passcodeCapabilityDeclared(declared)) return { kind: 'refused', reason: 'capability_missing' }
	try {
		await send({ ...UI_LOCKED_COMMAND })
		return { kind: 'sent' }
	} catch {
		return { kind: 'failed' }
	}
}

export type UiUnlockStep = 'native_identity_check' | 'passcode_unlock'

/** After a UI unlock: native already unlocked → same-mnemonic check only; native locked → passcodeUnlock. */
export function uiUnlockStep(nativeUnlocked: boolean): UiUnlockStep {
	return nativeUnlocked ? 'native_identity_check' : 'passcode_unlock'
}
