import { ethers } from 'ethers'

/**
 * 1423 / item 1: a device hint (a public EOA kept on this device) is accepted only when it equals the EOA derived from the valid
 * mnemonic on the page (BIP-39 English, empty passphrase, m/44'/60'/0'/0/0, index 0). A hint alone is never account evidence.
 */
export function hintMatchesMnemonic(hint: string, mnemonic: string): boolean {
	const h = String(hint || '').trim().toLowerCase()
	if (!/^0x[0-9a-f]{40}$/.test(h)) return false
	const phrase = String(mnemonic || '').trim()
	if (!phrase) return false
	try {
		return ethers.Wallet.fromPhrase(phrase).address.toLowerCase() === h
	} catch {
		return false
	}
}
