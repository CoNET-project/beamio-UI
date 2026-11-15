/**
 * the create page shows a specific copy for the two fail-closed reuse outcomes instead of the generic
 * local error. Other local errors keep `create_account_local_error`. Copy keys live in src/locale (placeholders pending ).
 */
export const createRecoverCopyKey = (step: string | undefined): string => {
	if (step === 'mnemonic_missing') return 'create_account_mnemonic_missing'
	// reuse_key_changed is a guard failure that should not happen; it uses the existing-key copy (and is logged in createRecover).
	if (step === 'existing_key_required' || step === 'reuse_key_changed') return 'create_account_existing_key_required'
	return 'create_account_local_error'
}
