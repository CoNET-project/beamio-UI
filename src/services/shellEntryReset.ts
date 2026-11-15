/**
 * review: the App forgets which account a shell has entered. Dispatched on sign-out, so the account's next wake-up
 * runs the init again (the vault lock is handled by VAULT_LOCKED_EVENT).
 */
export const SHELL_ENTRY_RESET_EVENT = 'beamio:shell-entry-reset'
