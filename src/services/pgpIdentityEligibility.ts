/**
 * First-identity eligibility (first-identity rule, section six). A wallet may show or send the "create the first chat identity"
 * action only when the native answer confirms both: the legacy report is ABSENT (no old store with chat data) and the chain has no
 * AddressPGP registration. A missing field, or any unknown value, is unknown and closes the action (fail closed). The rule is the same in a
 * production build and in a QA build. The eligibility is in memory only: the page does not store the conclusion.
 */

export type LegacyReportState = 'ABSENT' | 'PRESENT' | 'UNREADABLE' | 'unknown'
export type ChainRegistrationState = 'unregistered' | 'registered' | 'unknown'

export const LEGACY_REPORT_STATES: readonly string[] = ['ABSENT', 'PRESENT', 'UNREADABLE']
export const CHAIN_REGISTRATION_STATES: readonly string[] = ['unregistered', 'registered']

/** True only for ABSENT and unregistered. Everything else (including unknown values) is not a first identity. */
export function firstIdentityConfirmed(ev: { legacy?: LegacyReportState; chain?: ChainRegistrationState }): boolean {
	// a missing field (undefined) is unknown: it confirms nothing
	return ev.legacy === 'ABSENT' && ev.chain === 'unregistered'
}

const eligible = new Set<string>()
const keyOf = (accountKey: string): string => String(accountKey ?? '').trim().toLowerCase()

/** Called only after the native answer confirmed a first identity for this account (the shell start). */
export function grantPgpCreateEligibility(accountKey: string): void {
	const k = keyOf(accountKey)
	if (k) eligible.add(k)
}

export function revokePgpCreateEligibility(accountKey?: string): void {
	if (accountKey === undefined) eligible.clear()
	else eligible.delete(keyOf(accountKey))
}

export function pgpCreateEligible(accountKey: string): boolean {
	const k = keyOf(accountKey)
	return k !== '' && eligible.has(k)
}
