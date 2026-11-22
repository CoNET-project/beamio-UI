/**
 * the key-only entry decision. A record with a private key and no mnemonic enters (the bar shows); a record with
 * neither key nor mnemonic is held (the bar stays hidden, as before). SYNTHETIC values only.
 */
import { keyOnlyEntryDecision } from './keyOnlyEntry'

const KEY = `0x${'11'.repeat(32)}`
const keyOnly = { profiles: [{ keyID: '0x1111111111111111111111111111111111111111', privateKeyArmor: KEY }] } as unknown as encrypt_keys_object
const r1NoKey = { profiles: [{ keyID: '0x1111111111111111111111111111111111111111' }], beamio: { accountName: 'synthtag' } } as unknown as encrypt_keys_object
// public BIP39 test vector (zero entropy), not a user's phrase
const withMnemonic = { ...keyOnly, mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' } as unknown as encrypt_keys_object

describe('keyOnlyEntryDecision', () => {
	// Old expectation (before 2026-11-17): "a private key with no mnemonic, in the browser build, enters as key-only" (enter_key_only).
	// New: held, never an entry; the gate decides (onboarding).
	it('a private key with no mnemonic, in the browser build, is held (not an entry); the gate decides', () => {
		expect(keyOnlyEntryDecision(keyOnly, false)).toBe('hold_no_key')
	})
	it('no key and no mnemonic (the BeamioTag-only record) is held, so the bar stays hidden', () => {
		expect(keyOnlyEntryDecision(r1NoKey, false)).toBe('hold_no_key')
	})
	it('a record with a mnemonic is not key-only', () => {
		expect(keyOnlyEntryDecision(withMnemonic, false)).toBe('not_key_only')
	})
	it('a shell build decides elsewhere', () => {
		expect(keyOnlyEntryDecision(keyOnly, true)).toBe('not_key_only')
		expect(keyOnlyEntryDecision(r1NoKey, true)).toBe('not_key_only')
	})
	it('an empty record is held', () => {
		expect(keyOnlyEntryDecision(null, false)).toBe('hold_no_key')
	})
})
