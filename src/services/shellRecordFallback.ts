/**
 * Shell native record read: a command the shell does not support (not_supported) is a definite old-shell capability gap, not an
 * unknown or a read failure (2026-11-21). The native record is then absent, so the start reads the page's own store next, as the
 * 0.52.935 start did (AppEntryGate read the page store). A timeout, a refusal or any other error stays a hold (retry).
 */
export const SHELL_RECORD_NOT_SUPPORTED_ERROR = 'shell_record_not_supported'
/** iOS answers an unknown command with ack(ok:false, error:"unknown_command") (BeamioConetChatModule.swift 154–158). */
export const SHELL_RECORD_UNKNOWN_COMMAND_ERROR = 'shell_record_unknown_command'
/**
 * The shell refuses this page as untrusted (its bridge trust check, `ok:false error:"untrusted_source"`). It is NOT a fallback
 *: the native lock is checked first on that shell, and the page
 * store may hold a plaintext mnemonic. The start waits and retries (native_retry), never enters from the page, never onboards.
 */
export const SHELL_RECORD_UNTRUSTED_SOURCE_ERROR = 'shell_record_untrusted_source'
export type ShellRecordFallbackReason = 'not_supported' | 'unknown_command'

/**
 * The decision for a shell record read error message: `fallback` (the shell definitely does not support the command: read the page
 * store, then the native walletEoaAddress decides an empty store) or null (keep the hold).
 */
export function nativeRecordFallbackOf(errorMessage: string): { kind: 'fallback'; reason: ShellRecordFallbackReason } | null {
	const m = errorMessage.trim()
	if (m === SHELL_RECORD_NOT_SUPPORTED_ERROR) return { kind: 'fallback', reason: 'not_supported' }
	if (m === SHELL_RECORD_UNKNOWN_COMMAND_ERROR) return { kind: 'fallback', reason: 'unknown_command' }
	return null
}

/** The storage read's terminal state as page evidence (for the gate's first page read): the update prompt, or null. */
export function terminalEvidenceOf(storage: { status: string; reason?: string }): { kind: 'terminal' } | null {
	return storage.status === 'unavailable' && storage.reason === OLD_SHELL_UPGRADE_REASON ? { kind: 'terminal' } : null
}

/**
 * The fallback shell (its native record command is definitely absent: shellRecordRead not_supported / unknown_command) start outcome
 * (the decision, 2026-11-21). It never consults walletEoaAddress and never writes the native side:
 * - the page store holds an account → `enter` (/chat);
 * - the page store is confirmed empty → `terminal` (the update prompt; no entry, no creation, recovery or import);
 * - a read failure, timeout or unknown legacy answer → `wait` (retry).
 */
export function fallbackStartOutcome(input: { legacy: 'valid' | 'absent' | 'unknown' }): 'enter' | 'terminal' | 'wait' {
	if (input.legacy === 'valid') return 'enter'
	if (input.legacy === 'absent') return 'terminal'
	return 'wait'
}

/**
 * The native reason of the last fallback start (for the diagnostic only; never a decision input). Written by the storage read when it
 * takes the fallback branch, read by the gate's terminal log so the line names the real command answer.
 */
let lastFallbackReason: ShellRecordFallbackReason | null = null
export function noteShellRecordFallback(reason: ShellRecordFallbackReason): void {
	lastFallbackReason = reason
}
export function shellRecordFallbackLabel(): string {
	return lastFallbackReason ?? 'unrecorded'
}

/** The terminal reason the storage read returns for the fallback shell's confirmed-empty page store (the gate shows the update prompt). */
export const OLD_SHELL_UPGRADE_REASON = 'old_shell_upgrade_required'
