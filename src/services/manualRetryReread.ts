/**
 * PWA-RETRY-03: a manual retry of write_failed internal_state or storage_write first rereads the native account
 * (walletEoaAddress). A valid (address) or absent (no_key) answer sends; unknown (anything else, or no answer) does not send.
 * unknown_reply is not produced by the current sync path, so it has no branch here (noted in the receipt).
 */
import type { ShellSyncState } from './shellSyncStatus'

export type RereadAnswer = { kind: 'address' } | { kind: 'refused'; code: string } | { kind: 'timeout' }

export function rereadDecision(a: RereadAnswer): 'send' | 'hold' {
	if (a.kind === 'address') return 'send'
	if (a.kind === 'refused' && a.code === 'no_key') return 'send'
	return 'hold'
}

/**
 * Whether a manual retry of this state must reread first: write_failed internal_state or
 * storage_write, and no_answer (the unknown-reply class). A manual retry after no_answer rereads first too; an unknown reread does not send.
 */
export function needsReread(state: ShellSyncState): boolean {
	if (state.kind !== 'failed') return false
	if (state.code === 'no_answer') return true
	if (state.code !== 'write_failed') return false
	return state.reason === 'internal_state' || state.reason === 'storage_write'
}
