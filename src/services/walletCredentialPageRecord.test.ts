/**
 * @jest-environment node
 *
 * The page record is used only for the native account: a match on the first profile's keyID, case-insensitive.
 */
import { pageRecordAccountMatches } from './walletCredential'

const EOA = '0x' + 'aB'.repeat(20)

describe('page record account check', () => {
	it('matches the native account, ignoring case', () => {
		expect(pageRecordAccountMatches({ profiles: [{ keyID: EOA.toLowerCase() }] }, EOA)).toBe(true)
		expect(pageRecordAccountMatches({ profiles: [{ keyID: EOA.toUpperCase().replace('0X', '0x') }] }, EOA)).toBe(true)
	})

	it('a record of another account does not match', () => {
		expect(pageRecordAccountMatches({ profiles: [{ keyID: '0x' + '2'.repeat(40) }] }, EOA)).toBe(false)
	})

	it('a record without a valid account does not match', () => {
		expect(pageRecordAccountMatches({ profiles: [{ keyID: 'not-an-address' }] }, EOA)).toBe(false)
		expect(pageRecordAccountMatches({ profiles: [] }, EOA)).toBe(false)
		expect(pageRecordAccountMatches({}, EOA)).toBe(false)
		expect(pageRecordAccountMatches(null, EOA)).toBe(false)
	})
})
