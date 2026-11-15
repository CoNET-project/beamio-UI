/**
 * (key-only entry): the App's init decides what a key-only record means for the shell chrome. A record with a
 * private key and no local mnemonic enters the app (the global bar and search show; see App's init). A record with neither a key
 * nor a mnemonic is not an entry: the loading flag stays set, so the bar stays hidden while the entry gate shows its own state
 * (storage unavailable, recovery). Browser build only: a shell build decides elsewhere.
 */
import { hasLocalPlaintextMnemonic, hasLocalPrivateKeyArmor } from '@/utils/consumerWalletGate'

export type KeyOnlyEntry = 'not_key_only' | 'enter_key_only' | 'hold_no_key'

export function keyOnlyEntryDecision(data: encrypt_keys_object | null | undefined, shell: boolean): KeyOnlyEntry {
	if (shell || hasLocalPlaintextMnemonic(data)) return 'not_key_only'
	return hasLocalPrivateKeyArmor(data) ? 'enter_key_only' : 'hold_no_key'
}
