/**
 * @jest-environment node
 */
/**
 * The claimBUnits gate on the first-open path: on the browser first-open path (no PGP record, the SDK confirms it)
 * no automatic claim is sent; every other state keeps the claim. SYNTHETIC values only.
 */
import { skipAutoBUnitClaimForFirstOpen } from './firstOpenClaimGate'

jest.mock('openpgp', () => ({ generateKey: async () => ({}), readKey: async () => ({}) }))

const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nS\n-----END PGP PUBLIC KEY BLOCK-----'
const ABSENT = { status: 'no_record' as const }
const BASE = { shell: false, lookup: ABSENT, localChatKeyComplete: false, pendingPresent: false }

describe('claimBUnits on the first-open path', () => {
	it('the browser first-open path (no record, the SDK confirms it): the automatic claim is not sent', () => {
		expect(skipAutoBUnitClaimForFirstOpen(BASE)).toBe(true)
	})

	it('a saved pending copy on this path is still the first open: the claim is not sent', () => {
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, pendingPresent: true })).toBe(true)
	})

	it('a record on the chain: the claim is kept (not the first-open path)', () => {
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, lookup: { status: 'ok', publicArmored: ARMOR, routersArmoreds: ARMOR } })).toBe(false)
	})

	it('an unknown read (a failed or incomplete answer) is never absent: the claim is kept', () => {
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, lookup: { status: 'network_error' } })).toBe(false)
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, lookup: { status: 'ok', publicArmored: 'garbage', routersArmoreds: ARMOR } })).toBe(false)
	})

	it('an existing complete chat key is an old identity: the claim is kept', () => {
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, localChatKeyComplete: true })).toBe(false)
	})

	it('a shell is never the browser first-open path: the claim is kept', () => {
		expect(skipAutoBUnitClaimForFirstOpen({ ...BASE, shell: true })).toBe(false)
	})
})
