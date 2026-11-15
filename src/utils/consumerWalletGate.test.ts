/**
 * Scheme A: in a shell the native side holds the EOA key and owns recovery. An account with the EOA key and no
 * plaintext mnemonic is entered (not sent to the page recovery). Outside a shell the old rule holds.
 */
import { pagePlaintextMnemonicMissing, pageWalletRecoverNeeded } from './consumerWalletGate'

const EOA = '0x' + '1'.repeat(40)
const withEoaNoMnemonic = { profiles: [{ keyID: EOA, privateKeyArmor: 'ARMOR' }], beamio: { accountName: 'alice' } } as any
const withMnemonicNoEoaKeyless = { profiles: [{ keyID: EOA }], mnemonicPhrase: 'w w w', beamio: { accountName: 'alice' } } as any

describe('scheme A: the shell never routes to page recovery; the EOA key is the native account', () => {
	it('shell: an EOA key without a plaintext mnemonic is entered, not recovered', () => {
		expect(pageWalletRecoverNeeded(withEoaNoMnemonic, true)).toBe(false)
		expect(pagePlaintextMnemonicMissing(withEoaNoMnemonic, true)).toBe(false)
	})

	it('browser: the old rule holds (a registered account without a plaintext mnemonic is recovered)', () => {
		expect(pageWalletRecoverNeeded(withEoaNoMnemonic, false)).toBe(true)
		expect(pagePlaintextMnemonicMissing(withEoaNoMnemonic, false)).toBe(true)
	})

	it('a mnemonic-only record needs no page recovery in either build (the mnemonic is present)', () => {
		expect(pageWalletRecoverNeeded(withMnemonicNoEoaKeyless, false)).toBe(false)
		expect(pageWalletRecoverNeeded(withMnemonicNoEoaKeyless, true)).toBe(false)
	})
})
