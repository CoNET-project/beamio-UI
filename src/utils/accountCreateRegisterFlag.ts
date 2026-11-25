/**
 * Two build-time facts that used to be one switch (REACT_APP_NEW_ACCOUNT_REGISTRATION).
 *
 * - ACCOUNT_CREATE_REGISTER_ENABLED: the shell's onboarding create (nativeAccountCreateOpen, then accountCreateRegister, then addUser) is on in every
 *   build since 0.53.50. What really gates it at run time is the shell capability `account.page-create.v1`: a shell that does not declare it
 *   gets the unavailable notice and nothing is sent.
 * - FIRST_IDENTITY_STATUS_ENABLED: the first-identity status events (the SDK sets up the first chat identity on its own; the page only shows the state).
 *   On in every build since 0.53.52. What gates it at run time is the shell capability `identity.first.status.v1` (see shellChatStart.ts): a shell that does
 *   not declare it gets the "identity pending" notice, no button and no command. REACT_APP_NEW_ACCOUNT_REGISTRATION no longer decides anything.
 */
export function newAccountRegistrationEnabledFor(raw: string | undefined): boolean {
	return raw === 'true'
}

export const ACCOUNT_CREATE_REGISTER_ENABLED = true as const
export const FIRST_IDENTITY_STATUS_ENABLED = true as const
