/**
 * The page copy for the identity-create result codes (r2h §四, r2g §一). A refusal and a success each get a message; codes with no
 * message of their own map to null. The success copy is one sentence shared by idempotent and already_registered_same_key.
 * Creation stays closed until the interface vectors are synced; this table only states what the page shows.
 */
export type IdentityCreateCopyKey =
	| 'chat.identity_create.pending_exists'
	| 'chat.identity_create.confirmation_missing'
	| 'chat.identity_create.success'
	| 'chat.identity_create.conflict'
	| 'chat.identity_create.already_exists'
	| 'chat.identity_create.retry'

const COPY: Readonly<Record<string, IdentityCreateCopyKey>> = {
	pending_exists: 'chat.identity_create.pending_exists',
	native_confirmation_missing: 'chat.identity_create.confirmation_missing',
	idempotent: 'chat.identity_create.success',
	already_registered_same_key: 'chat.identity_create.success',
	cas_conflict: 'chat.identity_create.conflict',
	// r2p §四: confirmation_not_native shares the native-confirmation refusal copy; already_exists is its own refusal (not a success)
	confirmation_not_native: 'chat.identity_create.confirmation_missing',
	already_exists: 'chat.identity_create.already_exists',
	// index z §27.1: retry_write covers a failed local wipe of the pending key; shown as retryable, never as success
	retry_write: 'chat.identity_create.retry',
	// index an §40.2: write_reverted (chain-write rollback) is retryable, never success
	write_reverted: 'chat.identity_create.retry',
}

/** The locale key prefix for a result code, or null when the code has no message of its own. */
export function identityCreateCopyKey(code: string): IdentityCreateCopyKey | null {
	return COPY[code] ?? null
}

/** Whether the code is a success (the same sentence for both success codes). */
export function identityCreateIsSuccess(code: string): boolean {
	return code === 'idempotent' || code === 'already_registered_same_key'
}
