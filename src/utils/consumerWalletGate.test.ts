/**
 * Scheme A: in a shell the native side holds the EOA key and owns recovery. An account with the EOA key and no
 * plaintext mnemonic is entered (not sent to the page recovery). Outside a shell the old rule holds.
 */
import { pagePlaintextMnemonicMissing, pageWalletRecoverNeeded } from './consumerWalletGate'

const EOA = '0x' + '1'.repeat(40)
const withEoaNoMnemonic = { profiles: [{ keyID: EOA, privateKeyArmor: 'ARMOR' }], beamio: { accountName: 'alice' } } as any
const withMnemonicNoEoaKeyless = { profiles: [{ keyID: EOA }], mnemonicPhrase: 'w w w', beamio: { accountName: 'alice' } } as any

describe('scheme A: the shell never routes to page recovery; the EOA key is the native account', () => {
	// Reviewed 2026-11-17: the expectation is a routing flag only (no page recovery). The account is decided by the native walletEoaAddress, not by this record.
	it('shell: an EOA key without a plaintext mnemonic is not a page recovery (the native side decides the account; the page record alone is not an account)', () => {
		expect(pageWalletRecoverNeeded(withEoaNoMnemonic, true)).toBe(false)
		expect(pagePlaintextMnemonicMissing(withEoaNoMnemonic, true)).toBe(false)
	})

	it('rule E: in the browser a key-only record (no mnemonic) is onboarding, not recovery; the record is kept (nothing is written here)', () => {
		expect(pageWalletRecoverNeeded(withEoaNoMnemonic, false)).toBe(false)
		expect(pagePlaintextMnemonicMissing(withEoaNoMnemonic, false)).toBe(true)
	})

	it('a mnemonic-only record needs no page recovery in either build (the mnemonic is present)', () => {
		expect(pageWalletRecoverNeeded(withMnemonicNoEoaKeyless, false)).toBe(false)
		expect(pageWalletRecoverNeeded(withMnemonicNoEoaKeyless, true)).toBe(false)
	})
})
