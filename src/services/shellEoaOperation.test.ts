/**
 * @jest-environment node
 *
 * Shell operation with the EOA key: the native EOA is read first, a refusal stops the operation, and the native EOA must
 * match the key derived from the unsealed phrase. Public zero-entropy vector only; no real key material.
 */
jest.mock('./walletCredential', () => ({ readWalletCredentialUnseal: jest.fn() }))
jest.mock('./walletEoaAddress', () => ({ readWalletEoaAddress: jest.fn() }))
import { ethers } from 'ethers'
import { readWalletCredentialUnseal } from './walletCredential'
import { readWalletEoaAddress } from './walletEoaAddress'
import { runShellEoaOperation } from './shellEoaOperation'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DERIVED = ethers.Wallet.fromPhrase(PHRASE)

beforeEach(() => {
	;(readWalletCredentialUnseal as jest.Mock).mockReset()
	;(readWalletEoaAddress as jest.Mock).mockReset()
	;(readWalletCredentialUnseal as jest.Mock).mockResolvedValue({ kind: 'credential', eoa: DERIVED.address.toLowerCase(), mnemonic: PHRASE, blob: null })
	;(readWalletEoaAddress as jest.Mock).mockResolvedValue({ kind: 'address', eoa: DERIVED.address })
})

describe('a shell operation that needs the EOA key', () => {
	it('signs with the key derived from the unsealed phrase when the native EOA matches', async () => {
		const out = await runShellEoaOperation('sealed', async (session) => new ethers.Wallet(session.signingKey()).address)
		expect(out).toBe(DERIVED.address)
		expect(readWalletCredentialUnseal).toHaveBeenCalledWith('sealed')
	})

	it('a native refusal stops the operation before anything is unsealed', async () => {
		;(readWalletEoaAddress as jest.Mock).mockResolvedValueOnce({ kind: 'refused', code: 'locked' })
		const use = jest.fn(async () => 'never')
		await expect(runShellEoaOperation('sealed', use)).rejects.toMatchObject({ code: 'locked' })
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
		expect(use).not.toHaveBeenCalled()
	})

	it('a native EOA that differs from the unsealed phrase fails closed', async () => {
		;(readWalletEoaAddress as jest.Mock).mockResolvedValueOnce({ kind: 'address', eoa: '0x' + '5'.repeat(40) })
		const use = jest.fn(async () => 'never')
		await expect(runShellEoaOperation('sealed', use)).rejects.toMatchObject({ code: 'eoa_mismatch' })
		expect(use).not.toHaveBeenCalled()
	})

	it('a missing blob fails before the native unseal', async () => {
		const use = jest.fn(async () => 'never')
		await expect(runShellEoaOperation(null, use)).rejects.toMatchObject({ code: 'no_blob' })
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
		expect(use).not.toHaveBeenCalled()
	})
})
