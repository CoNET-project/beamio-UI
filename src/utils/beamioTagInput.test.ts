import { normalizeBeamioTagInput } from './beamioTagInput'

describe('normalizeBeamioTagInput: one rule for create and restore', () => {
	it('a leading @, a fullwidth form and a zero-width character give the same lookup key as the plain tag', () => {
		const plain = 'alice_01'
		const key = (s: string) => normalizeBeamioTagInput(s).toLowerCase()
		expect(key('@alice_01')).toBe(plain)
		expect(key('ａｌｉｃｅ＿０１')).toBe(plain)
		expect(key('alice​_01')).toBe(plain)
	})
	it('case mixed: the same key after the lookup lower-casing', () => {
		expect(normalizeBeamioTagInput('@Alice_01').toLowerCase()).toBe(normalizeBeamioTagInput('alice_01').toLowerCase())
	})
	it('removes every @, not only a leading one', () => {
		expect(normalizeBeamioTagInput('@al@ice')).toBe('alice')
	})
})

import { BEAMIO_TAG_MESSAGE_KEY, BEAMIO_TAG_PATTERN } from './beamioTagInput'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('one BeamioTag rule on create and restore', () => {
	it('a hyphenated name is not a valid tag on either screen (the same pattern and the same message key)', () => {
		expect(BEAMIO_TAG_PATTERN.test('alice-01')).toBe(false)
		expect(BEAMIO_TAG_PATTERN.test('alice_01')).toBe(true)
		expect(BEAMIO_TAG_MESSAGE_KEY).toBe('use_3_20_letters_numbers_dots_or_underscores')
	})
	it('the hyphenated name gives the same lookup key on create and restore (both use normalizeBeamioTagInput)', () => {
		const create = readFileSync(join(__dirname, '../pages/Home/CreateUsernamePinScreen.tsx'), 'utf8')
		const restore = readFileSync(join(__dirname, '../pages/Home/RestoreWalletUnifiedScreen.tsx'), 'utf8')
		for (const src of [create, restore]) {
			expect(src).toContain('BEAMIO_TAG_PATTERN.test(')
			expect(src).toContain('normalizeBeamioTagInput(')
			expect(src).not.toMatch(/\/\^\[a-zA-Z0-9_\.?-\]\{3,26\}\$\//)
		}
		expect(normalizeBeamioTagInput('@alice-01')).toBe('alice-01')
	})
})
