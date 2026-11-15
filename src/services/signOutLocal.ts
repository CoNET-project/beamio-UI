/**
 * Local sign-out ("Lock" in the UI). Shared by every entry point so the behaviour is the same wherever the user taps it.
 *
 * Order: lock the chat library (clears the rendered conversation), then the wallet passcode layer (drops the in-memory
 * secrets and asks for the passcode again). The gate shows the passcode screen only when a passcode is on.
 */
import { lockChatLocalOnLogout } from './chatLocalMigration'
import { lockWalletVaultOnLogout } from './beamio'
import { sendGlobalDestroyOnLogout } from './nativeKeyState'
import { VAULT_LOCKED_EVENT } from './walletVaultEvents'
import { SHELL_ENTRY_RESET_EVENT } from './shellEntryReset'
import { clearShellSessionSigner } from './shellSessionSigner'

export async function signOutLocalWallet(): Promise<void> {
	// the page-session key leaves memory first: a sign-out holds no account key.
	clearShellSessionSigner()
	// the App forgets the entered account, so a later wake-up for it runs the init again.
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHELL_ENTRY_RESET_EVENT))
	await lockChatLocalOnLogout()
	// The logout and lock path tears the native chat session down with a valid reqId.
	sendGlobalDestroyOnLogout()
	const passcodeOn = await lockWalletVaultOnLogout()
	if (passcodeOn && typeof window !== 'undefined') window.dispatchEvent(new Event(VAULT_LOCKED_EVENT))
}
