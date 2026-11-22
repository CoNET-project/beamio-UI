/**
 * (key-only entry): a record with no valid mnemonic is not an entry, with or without a private key. The App does not hold the loading flag for it and binds no push; the entry gate decides (onboarding when both
 * sides confirm none; retry on unknown). Browser build only: a shell build decides elsewhere.
 */
import { hasLocalPlaintextMnemonic } from '@/utils/consumerWalletGate'

// 2026-11-17: a key without a valid mnemonic is not an account in the browser either.
// It is never an entry: the gate decides (onboarding when the local store confirms none; unknown is kept and retried). The name is kept
// for the call sites; the App's branch no longer holds the loading flag.
export type KeyOnlyEntry = 'not_key_only' | 'hold_no_key'

export function keyOnlyEntryDecision(data: encrypt_keys_object | null | undefined, shell: boolean): KeyOnlyEntry {
	if (shell || hasLocalPlaintextMnemonic(data)) return 'not_key_only'
	// no valid mnemonic (with or without a key): held, the gate decides
	return 'hold_no_key'
}
