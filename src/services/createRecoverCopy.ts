/**
 * the create page shows a specific copy for the two fail-closed reuse outcomes instead of the generic
 * local error. Other local errors keep `create_account_local_error`. Copy keys live in src/locale (placeholders pending ).
 */
/** The copy for a failed remote registration: no answer (network, CORS) and a server answer with a non-2xx status are different messages. */
export const createRemoteErrorCopyKey = (kind: 'network' | 'http'): string => (kind === 'network' ? 'network_error_try_again' : 'create_account_try_later')

export const createRecoverCopyKey = (step: string | undefined): string => {
	if (step === 'mnemonic_missing') return 'create_account_mnemonic_missing'
	// reuse_key_changed is a guard failure that should not happen; it uses the existing-key copy (and is logged in createRecover).
	if (step === 'existing_key_required' || step === 'reuse_key_changed') return 'create_account_existing_key_required'
	return 'create_account_local_error'
}
