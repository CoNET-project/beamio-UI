/**
 * Two build-time facts that used to be one switch (REACT_APP_NEW_ACCOUNT_REGISTRATION).
 *
 * - ACCOUNT_CREATE_REGISTER_ENABLED: the shell's onboarding create (nativeAccountCreateOpen, then accountCreateRegister, then addUser) is on in every
 *   build since 0.53.50. What really gates it at run time is the shell capability `account.page-create.v1`: a shell that does not declare it
 *   gets the unavailable notice and nothing is sent.
 * - FIRST_IDENTITY_STATUS_ENABLED: the first-identity status events stay a QA feature. Only the QA build sets REACT_APP_NEW_ACCOUNT_REGISTRATION=true;
 *   the formal build keeps it false. It is no longer tied to the create flow.
 */
export function newAccountRegistrationEnabledFor(raw: string | undefined): boolean {
	return raw === 'true'
}

export const ACCOUNT_CREATE_REGISTER_ENABLED = true as const
export const FIRST_IDENTITY_STATUS_ENABLED: boolean = newAccountRegistrationEnabledFor(process.env.REACT_APP_NEW_ACCOUNT_REGISTRATION)
