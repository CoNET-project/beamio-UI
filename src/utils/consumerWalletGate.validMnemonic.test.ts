/**
 * @jest-environment node
 *
 * (node environment: ethers checks Buffer across realms, which jsdom breaks.)
 */
/**
 * 1423/1428: the account credential is a valid BIP39 mnemonic. A private key armor or a hint is not account evidence.
 */
import { hasLocalSigningMaterial, hasValidMnemonic } from './consumerWalletGate'


const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('hasValidMnemonic (1423/1428)', () => {
	it('a valid mnemonic that derives an EOA is account evidence', () => {
		expect(hasValidMnemonic({ mnemonicPhrase: PHRASE } as unknown as encrypt_keys_object)).toBe(true)
	})
	it('an invalid phrase is not', () => {
		expect(hasValidMnemonic({ mnemonicPhrase: 'not a real phrase at all' } as unknown as encrypt_keys_object)).toBe(false)
	})
	it('a private key armor alone is not account evidence (it is still signing material elsewhere)', () => {
		const data = { profiles: [{ keyID: '0x1111111111111111111111111111111111111111', privateKeyArmor: 'armor' }] } as unknown as encrypt_keys_object
		expect(hasLocalSigningMaterial(data)).toBe(true)
		expect(hasValidMnemonic(data)).toBe(false)
	})
	it('no data, or an empty phrase, is not account evidence', () => {
		expect(hasValidMnemonic(null)).toBe(false)
		expect(hasValidMnemonic({ mnemonicPhrase: '   ' } as unknown as encrypt_keys_object)).toBe(false)
	})
	it('the fixed BIP-39 sample derives the expected EOA with Wallet.fromPhrase (English, empty passphrase, path m/44 60 0 0 0, index 0)', () => {
		const { ethers } = require('ethers') as typeof import('ethers')
		expect(ethers.Wallet.fromPhrase(PHRASE).address.toLowerCase()).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94')
		expect(ethers.Wallet.fromPhrase(PHRASE).path).toBe("m/44'/60'/0'/0/0")
	})
})
