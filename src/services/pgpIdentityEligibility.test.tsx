/**
 * RULING 617d3dd9: a first identity needs legacy ABSENT and chain unregistered; any other value, or a missing field, is not confirmed.
 * The create button is not rendered without the eligibility, in every build (the switch is not the gate).
 */
import { render, screen } from '@testing-library/react'
import { firstIdentityConfirmed, grantPgpCreateEligibility, pgpCreateEligible, revokePgpCreateEligibility } from './pgpIdentityEligibility'

jest.mock('./nativeIdentityPublic', () => ({ shellAccountKeyOrEmpty: () => (globalThis as { __acct?: string }).__acct ?? '' }))
jest.mock('./shellContext', () => ({ isShellContext: () => (globalThis as { __shell?: boolean }).__shell !== false }))

describe('firstIdentityConfirmed: only ABSENT and unregistered', () => {
	it('confirms only the one combination', () => {
		expect(firstIdentityConfirmed({ legacy: 'ABSENT', chain: 'unregistered' })).toBe(true)
		expect(firstIdentityConfirmed({ legacy: 'PRESENT', chain: 'unregistered' })).toBe(false)
		expect(firstIdentityConfirmed({ legacy: 'UNREADABLE', chain: 'unregistered' })).toBe(false)
		expect(firstIdentityConfirmed({ legacy: 'unknown', chain: 'unregistered' })).toBe(false)
		expect(firstIdentityConfirmed({ legacy: 'ABSENT', chain: 'registered' })).toBe(false)
		expect(firstIdentityConfirmed({ legacy: 'ABSENT', chain: 'unknown' })).toBe(false)
	})
	it('a missing field is unknown: not confirmed', () => {
		expect(firstIdentityConfirmed({})).toBe(false)
		expect(firstIdentityConfirmed({ legacy: 'ABSENT' })).toBe(false)
		expect(firstIdentityConfirmed({ chain: 'unregistered' })).toBe(false)
	})
})

describe('the eligibility is per account, in memory, and revocable', () => {
	it('grants and revokes for one account (case-insensitive), nothing else', () => {
		const A = '0xAbCdEf0000000000000000000000000000000001'
		expect(pgpCreateEligible(A)).toBe(false)
		grantPgpCreateEligibility(A)
		expect(pgpCreateEligible(A.toLowerCase())).toBe(true)
		expect(pgpCreateEligible('0x0000000000000000000000000000000000000002')).toBe(false)
		revokePgpCreateEligibility(A)
		expect(pgpCreateEligible(A)).toBe(false)
	})
	it('an empty account is never eligible', () => {
		grantPgpCreateEligibility('')
		expect(pgpCreateEligible('')).toBe(false)
	})
})

describe('the first-identity notice renders the create button only for an eligible account', () => {
	it('not eligible: the body is shown and no create button is rendered', () => {
		;(globalThis as { __acct?: string }).__acct = '0x0000000000000000000000000000000000000003'
		revokePgpCreateEligibility()
		const PgpFirstIdentityNotice = require('../components/PgpFirstIdentityNotice').default
		render(<PgpFirstIdentityNotice />)
		expect(screen.queryByRole('button')).toBeNull()
	})
	it('a browser (not the shell) keeps the create button: the eligibility gate applies to the shell only', () => {
		;(globalThis as { __shell?: boolean }).__shell = false
		;(globalThis as { __acct?: string }).__acct = '0x0000000000000000000000000000000000000005'
		revokePgpCreateEligibility()
		const PgpFirstIdentityNotice = require('../components/PgpFirstIdentityNotice').default
		render(<PgpFirstIdentityNotice />)
		expect(screen.getByRole('button')).toBeTruthy()
		;(globalThis as { __shell?: boolean }).__shell = true
	})
	it('eligible: the create button is rendered', () => {
		;(globalThis as { __acct?: string }).__acct = '0x0000000000000000000000000000000000000004'
		grantPgpCreateEligibility('0x0000000000000000000000000000000000000004')
		const PgpFirstIdentityNotice = require('../components/PgpFirstIdentityNotice').default
		render(<PgpFirstIdentityNotice />)
		expect(screen.getByRole('button')).toBeTruthy()
	})
})
