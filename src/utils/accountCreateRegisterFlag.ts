/**
 * Build-time switch for the shell's new-account registration (accountCreateRegister) and the first-identity status events.
 * Only the QA build sets REACT_APP_NEW_ACCOUNT_REGISTRATION=true (frozen text: production waits for acceptance). Elsewhere the value is false:
 * the existing native create flow stays as it is and no accountCreateRegister command is sent.
 */
export function newAccountRegistrationEnabledFor(raw: string | undefined): boolean {
	return raw === 'true'
}

export const ACCOUNT_CREATE_REGISTER_ENABLED: boolean = newAccountRegistrationEnabledFor(process.env.REACT_APP_NEW_ACCOUNT_REGISTRATION)
export const FIRST_IDENTITY_STATUS_ENABLED: boolean = ACCOUNT_CREATE_REGISTER_ENABLED
