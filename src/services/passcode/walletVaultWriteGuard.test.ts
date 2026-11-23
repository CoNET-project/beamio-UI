/**
 * @jest-environment node
 *
 * The write refusal (0.53.39, independent review item 1): a write that could lose a stored secret, or whose identity is not
 * certain, is refused before anything is written. Synthetic values only.
 */
import { assertStoredSecretsKept, keepStoredSecretsForEmptySlots } from './walletVault'

const KEY = '0x' + '11'.repeat(32)
const KEY_B = '0x' + '44'.repeat(32)
const EOA = '0x' + '22'.repeat(20)
const EOA_B = '0x' + '55'.repeat(20)
const PHRASE_B_SYNTH = 'synthetic stored mnemonic of account B (not a phrase)'

const refused = (fn: () => void): string => {
	try {
		fn()
		return 'allowed'
	} catch (e) {
		return (e as { code?: string; message?: string }).code ?? (e as Error).message
	}
}

describe('the refusal: a write that could lose a stored secret is refused', () => {
	it('(a) a stored key whose slot has no keyID: the write that would empty it is refused (never a silent loss)', () => {
		const stored = { profiles: [{ privateKeyArmor: KEY }] }
		const written = keepStoredSecretsForEmptySlots({ profiles: [{ privateKeyArmor: '' }] }, stored)
		expect(refused(() => assertStoredSecretsKept(stored, written))).toMatch(/secret_would_be_lost|VaultError|secret/)
	})

	it('(b) the primary account switched in memory: the stored mnemonic of B is not written over by an empty slot for A (refused)', () => {
		const stored = { mnemonicPhrase: PHRASE_B_SYNTH, profiles: [{ keyID: EOA_B, privateKeyArmor: KEY_B }] }
		const memory = { mnemonicPhrase: '', profiles: [{ keyID: EOA, privateKeyArmor: '' }] }
		const written = keepStoredSecretsForEmptySlots(memory, stored)
		expect(refused(() => assertStoredSecretsKept(stored, written))).not.toBe('allowed')
	})

	it('(c) two stored records with the same keyID: which key is kept is not known, the write is refused', () => {
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }, { keyID: EOA, privateKeyArmor: KEY_B }] }
		const written = keepStoredSecretsForEmptySlots({ profiles: [{ keyID: EOA, privateKeyArmor: '' }, { keyID: EOA, privateKeyArmor: '' }] }, stored)
		expect(refused(() => assertStoredSecretsKept(stored, written))).not.toBe('allowed')
	})

	it('the ordinary case passes: the same account, the stored key kept, nothing refused', () => {
		const stored = { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }
		const written = keepStoredSecretsForEmptySlots({ profiles: [{ keyID: EOA, privateKeyArmor: '' }] }, stored)
		expect(refused(() => assertStoredSecretsKept(stored, written))).toBe('allowed')
	})

	it('nothing stored: nothing can be lost, the write is allowed', () => {
		expect(refused(() => assertStoredSecretsKept({}, { profiles: [{ keyID: EOA, privateKeyArmor: '' }] }))).toBe('allowed')
	})
})
