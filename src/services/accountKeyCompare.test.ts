/**
 * @jest-environment node
 *
 * CT-14: the accountKey EOA is compared with the expected EOA, both lower-cased. CT-14a/b/c are the three cases of the plan.
 */
import { accountKeyMatch } from './accountKeyCompare'

const LOWER = '0xabc1234567890abcdef1234567890abcdef12345'
const MIXED = '0xAbC1234567890ABCDEF1234567890abcdef12345'
const OTHER = '0x1111111111111111111111111111111111111111'

describe('CT-14: accountKey EOA comparison (both sides lower-cased)', () => {
	it('CT-14a: the same address in mixed case is equal', () => {
		expect(accountKeyMatch(MIXED, `${LOWER}:workspace`)).toBe('equal')
		expect(accountKeyMatch(LOWER, `${MIXED}:workspace`)).toBe('equal')
	})

	it('CT-14b: a different address is different (not equal, not unknown)', () => {
		expect(accountKeyMatch(LOWER, `${OTHER}:workspace`)).toBe('different')
	})

	it('CT-14c: a missing side, or a side that is not an address, is unknown', () => {
		expect(accountKeyMatch(undefined, `${LOWER}:workspace`)).toBe('unknown')
		expect(accountKeyMatch(LOWER, undefined)).toBe('unknown')
		expect(accountKeyMatch(LOWER, '')).toBe('unknown')
		expect(accountKeyMatch('not-an-address', `${LOWER}:workspace`)).toBe('unknown')
		expect(accountKeyMatch(LOWER, 'garbage')).toBe('unknown')
	})
})

import { classifyPageDerived } from './accountKeyCompare'

describe('PD-A/B/C', () => {
	const EXPECTED = '0xAbC1234567890ABCDEF1234567890abcdef12345'
	const SAME = '0xabc1234567890abcdef1234567890abcdef12345:workspace'
	const OTHER = '0x1111111111111111111111111111111111111111:workspace'

	it('PD-A-AND: unlocked with the same EOA (mixed case) is A', () => {
		expect(classifyPageDerived(EXPECTED, { status: 'unlocked', accountKey: SAME })).toBe('A')
	})

	it('PD-B-AND: unlocked with another EOA is B', () => {
		expect(classifyPageDerived(EXPECTED, { status: 'unlocked', accountKey: OTHER })).toBe('B')
	})

	it('PD-C-AND: locked, unknown, timed out, unlocked without an accountKey, or a missing side is C', () => {
		expect(classifyPageDerived(EXPECTED, { status: 'locked' })).toBe('C')
		expect(classifyPageDerived(EXPECTED, { status: 'unknown' })).toBe('C')
		expect(classifyPageDerived(EXPECTED, { status: 'timeout' })).toBe('C')
		expect(classifyPageDerived(EXPECTED, { status: 'unlocked' })).toBe('C')
		expect(classifyPageDerived(undefined, { status: 'unlocked', accountKey: SAME })).toBe('C')
		expect(classifyPageDerived(EXPECTED, null)).toBe('C')
	})
})
