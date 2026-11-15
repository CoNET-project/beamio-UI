/**
 * Build-time switch for the chain write of a new chat identity (`pgpIdentityCreate`;  plan A).
 *
 * The switch is read from `REACT_APP_PGP_IDENTITY_CREATE_ENABLED` when the bundle is built. Only the QA build sets it to `true`
 * (`npm run build:qa-embedded`). The production and store builds do not set it, so the value there is `false`. Create React App
 * inlines `REACT_APP_*` values at build time, so the page cannot change the value at run time.
 *
 * Restore failure never creates a key by itself: the page shows the first-identity entry, and only the user's click reaches the
 * command (see PgpFirstIdentityNotice.tsx).
 */
export function pgpIdentityCreateEnabledFor(raw: string | undefined): boolean {
	return raw === 'true'
}

export const PGP_IDENTITY_CREATE_ENABLED: boolean = pgpIdentityCreateEnabledFor(process.env.REACT_APP_PGP_IDENTITY_CREATE_ENABLED)
