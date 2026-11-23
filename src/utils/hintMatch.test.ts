/**
 * @jest-environment node
 */
import { hintMatchesMnemonic } from './hintMatch'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DERIVED = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('hintMatchesMnemonic (R65 item 1)', () => {
	it('a hint equal to the EOA derived from the valid mnemonic is accepted', () => {
		expect(hintMatchesMnemonic(DERIVED, PHRASE)).toBe(true)
		expect(hintMatchesMnemonic(DERIVED.toUpperCase().replace('0X', '0x'), PHRASE)).toBe(true)
	})
	it('a hint that differs from the derived EOA is not accepted', () => {
		expect(hintMatchesMnemonic('0x1111111111111111111111111111111111111111', PHRASE)).toBe(false)
	})
	it('no mnemonic, an invalid mnemonic, or a malformed hint is not accepted', () => {
		expect(hintMatchesMnemonic(DERIVED, '')).toBe(false)
		expect(hintMatchesMnemonic(DERIVED, 'not a real phrase')).toBe(false)
		expect(hintMatchesMnemonic('0xzz', PHRASE)).toBe(false)
	})
})
