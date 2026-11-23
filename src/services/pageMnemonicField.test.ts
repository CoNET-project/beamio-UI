/** The page's mnemonicPhrase field: every shape is classified; only absent is "no mnemonic" (2026-11-22, item 2). */
import { pageMnemonicField } from './pageMnemonicField'
import { isKeyOnlyCopyWithoutMnemonic } from '../utils/consumerWalletGate'

const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const ENV = { v: 3, mode: 'passcode', eoa: EOA, kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: 'AAECAwQFBgcICQoLDA0ODw==', iv: 'AAECAwQFBgcICQoL', alg: 'AES-256-GCM', ct: 'AAAA' }

describe('pageMnemonicField: the field is classified, and only absent means no mnemonic', () => {
	it('absent: missing, null, empty string and whitespace-only string', () => {
		expect(pageMnemonicField({}).kind).toBe('absent')
		expect(pageMnemonicField({ mnemonicPhrase: null }).kind).toBe('absent')
		expect(pageMnemonicField({ mnemonicPhrase: '' }).kind).toBe('absent')
		expect(pageMnemonicField({ mnemonicPhrase: '   ' }).kind).toBe('absent')
	})
	it('phrase: a string is the plaintext phrase, trimmed', () => {
		expect(pageMnemonicField({ mnemonicPhrase: '  abandon about  ' })).toEqual({ kind: 'phrase', phrase: 'abandon about' })
	})
	it('envelope: a v3 object is the envelope, never a phrase', () => {
		expect(pageMnemonicField({ mnemonicPhrase: ENV })).toEqual({ kind: 'envelope', envelope: ENV })
	})
	it('other: any other shape is other, never absent (a number, an array, an object without the v3 fields, a v2 envelope)', () => {
		for (const v of [7, ['a'], { foo: 'x' }, { ...ENV, v: 2 }, { ...ENV, eoa: 'not-an-address' }]) {
			expect(pageMnemonicField({ mnemonicPhrase: v }).kind).toBe('other')
		}
	})
	it('a record with a key armor and an envelope or other-shape field is not a key-only copy (never routed to onboarding)', () => {
		const armored = (m: unknown) => ({ mnemonicPhrase: m, profiles: [{ keyID: EOA, privateKeyArmor: '-----BEGIN PGP PRIVATE KEY BLOCK-----' }] })
		expect(isKeyOnlyCopyWithoutMnemonic(armored(ENV) as never)).toBe(false)
		expect(isKeyOnlyCopyWithoutMnemonic(armored({ foo: 'x' }) as never)).toBe(false)
		// an absent field with a key armor is still the key-only copy (the existing rule)
		expect(isKeyOnlyCopyWithoutMnemonic(armored(undefined) as never)).toBe(true)
	})
})
