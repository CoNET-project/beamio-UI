/**
 * The key-only test of the page record (the decision). SYNTHETIC values only.
 * key_only needs a plain record with a private key and no mnemonic. Address-only, wrapped (passcode, not unlocked), unparsable and absent
 * records are unknown (a neutral line, no entry).
 */
import { classifyPageKeyState } from './pageRecordKeyState'

const KEY = 'SYNTHETIC-ARMORED-PRIVATE-KEY-0001'
const EOA = '0x' + '11'.repeat(20)

describe('classifyPageKeyState (30046b27)', () => {
	it('a record with a private key and no mnemonic here is key_only', () => {
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('key_only')
	})

	it('an address-only record (no private key, no mnemonic) is unknown, never key_only', () => {
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA }] })).toBe('unknown')
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA, privateKeyArmor: '   ' }] })).toBe('unknown')
	})

	it('a record with a mnemonic here is not key_only (the has-mnemonic path decides it)', () => {
		expect(classifyPageKeyState({ mnemonicPhrase: 'synthetic words', profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
	})

	it('a wrapped (passcode) record that is not unlocked is unknown, never key_only', () => {
		const wrapped = { profiles: [{ keyID: EOA }], mnemonicPhrase: { v: 3, mode: 'passcode', ct: 'synthetic' }, privateKeyArmor: { v: 3, mode: 'passcode', ct: 'synthetic' } }
		expect(classifyPageKeyState(wrapped as unknown as Record<string, unknown>)).toBe('unknown')
	})

	it('a mnemonic field that is set but not a plain string (a future format, or an object not opened here) is unknown, never key_only (f828dace)', () => {
		expect(classifyPageKeyState({ mnemonicPhrase: { v: 4, ct: 'synthetic' }, profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
		expect(classifyPageKeyState({ mnemonicPhrase: 12345, profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
	})

	it('the removed formats with a private key and no mnemonic are unknown, never key_only (f828dace A, B, C)', () => {
		// A: v 1 with PBKDF2 at the top
		expect(classifyPageKeyState({ v: 1, kdf: 'PBKDF2-SHA256', profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
		// B: v 2 with device mode and an empty phrase
		expect(classifyPageKeyState({ v: 2, mode: 'device', mnemonicPhrase: '', profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
		// C: device mode at the top, no phrase field
		expect(classifyPageKeyState({ mode: 'device', profiles: [{ keyID: EOA, privateKeyArmor: KEY }] })).toBe('unknown')
	})

	it('a wrapped or removed-format record in another slot makes the record unknown (the whole record is not read here)', () => {
		// a real wrap record shape (isWrapRecord): v 3, passcode mode, salt, ct and iv
		const wrappedSlot = { v: 3, mode: 'passcode', salt: 'c3ludGhldGlj', ct: 'c3ludGhldGlj', iv: 'c3ludGhldGlj', eoa: EOA }
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }], someSlot: wrappedSlot })).toBe('unknown')
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }], otherSlot: { v: 1, kdf: 'PBKDF2-SHA256' } })).toBe('unknown')
	})

	it('the four wrap-in-another-slot probes (f828dace): a removed-format or wrapped record at the top or in profiles[0] is unknown, never key_only', () => {
		const phraseMissing = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const pbkdf2Wrap = { v: 1, kdf: 'PBKDF2-SHA256', ct: 'synthetic', salt: 'c3ludGhldGlj', iv: 'c3ludGhldGlj' }
		const deviceWrap = { v: 2, mode: 'device', ct: 'synthetic', iv: 'c3ludGhldGlj' }
		expect(classifyPageKeyState({ ...phraseMissing, mnemonicWrap: pbkdf2Wrap })).toBe('unknown')
		expect(classifyPageKeyState({ ...phraseMissing, mnemonicWrap: deviceWrap })).toBe('unknown')
		expect(classifyPageKeyState({ ...phraseMissing, keyWrap: pbkdf2Wrap })).toBe('unknown')
		expect(classifyPageKeyState({ profiles: [{ keyID: EOA, privateKeyArmor: KEY, wrap: deviceWrap }] })).toBe('unknown')
		expect(classifyPageKeyState({ mnemonicPhrase: '', profiles: [{ keyID: EOA, privateKeyArmor: KEY, wrap: pbkdf2Wrap }] })).toBe('unknown')
	})

	it('an absent or unparsable record is unknown', () => {
		expect(classifyPageKeyState(null)).toBe('unknown')
		expect(classifyPageKeyState(undefined)).toBe('unknown')
	})
})
