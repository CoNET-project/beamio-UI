/**
 * @jest-environment node
 *
 * One shell operation with the EOA key: the address derived from the unsealed phrase must equal the native EOA, a mismatch
 * fails closed, and the key is revoked when the operation ends. The phrase is the public zero-entropy vector; no real key material.
 */
jest.mock('./walletCredential', () => ({ readWalletCredentialUnseal: jest.fn() }))
import { ethers } from 'ethers'
import { readWalletCredentialUnseal } from './walletCredential'
import { ShellOperationKeyError, withShellOperationKey, type ShellOperationSession } from './shellOperationKey'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DERIVED = ethers.Wallet.fromPhrase(PHRASE)
const OTHER = '0x' + '4'.repeat(40)

beforeEach(() => {
	;(readWalletCredentialUnseal as jest.Mock).mockReset()
	;(readWalletCredentialUnseal as jest.Mock).mockResolvedValue({ kind: 'credential', eoa: DERIVED.address.toLowerCase(), mnemonic: PHRASE, blob: null })
})

describe('a shell operation with the EOA key', () => {
	it('the address derived from the unsealed phrase equals the native EOA, and the operation gets the key', async () => {
		const got: { eoa?: string; key?: string } = {}
		const out = await withShellOperationKey({ blob: 'sealed', expectedEoa: DERIVED.address }, async (session) => {
			got.eoa = session.eoa
			got.key = session.signingKey()
			return 'signed'
		})
		expect(out).toBe('signed')
		expect(got.eoa).toBe(DERIVED.address.toLowerCase())
		expect(got.key).toBe(DERIVED.privateKey)
	})

	it('a mismatch between the derived address and the expected EOA fails closed and runs nothing', async () => {
		const use = jest.fn(async () => 'never')
		await expect(withShellOperationKey({ blob: 'sealed', expectedEoa: OTHER }, use)).rejects.toMatchObject({ code: 'eoa_mismatch' })
		expect(use).not.toHaveBeenCalled()
	})

	it('a native answer for another account fails closed even when the phrase matches the expected EOA', async () => {
		;(readWalletCredentialUnseal as jest.Mock).mockResolvedValueOnce({ kind: 'credential', eoa: OTHER, mnemonic: PHRASE, blob: null })
		const use = jest.fn(async () => 'never')
		await expect(withShellOperationKey({ blob: 'sealed', expectedEoa: DERIVED.address }, use)).rejects.toMatchObject({ code: 'eoa_mismatch' })
		expect(use).not.toHaveBeenCalled()
	})

	it('after the operation ends, the key is revoked: a later read throws released', async () => {
		let kept: ShellOperationSession | null = null
		await withShellOperationKey({ blob: 'sealed', expectedEoa: DERIVED.address }, async (session) => {
			kept = session
			return null
		})
		expect(kept).not.toBeNull()
		expect(() => (kept as unknown as ShellOperationSession).signingKey()).toThrow(ShellOperationKeyError)
		expect(() => (kept as unknown as ShellOperationSession).signingKey()).toThrow('released')
	})

	it('the key is revoked even when the operation throws', async () => {
		let kept: ShellOperationSession | null = null
		await expect(
			withShellOperationKey({ blob: 'sealed', expectedEoa: DERIVED.address }, async (session) => {
				kept = session
				throw new Error('operation failed')
			}),
		).rejects.toThrow('operation failed')
		expect(() => (kept as unknown as ShellOperationSession).signingKey()).toThrow('released')
	})

	it('no blob: nothing is unsealed and nothing runs', async () => {
		const use = jest.fn(async () => 'never')
		await expect(withShellOperationKey({ blob: null, expectedEoa: DERIVED.address }, use)).rejects.toMatchObject({ code: 'no_blob' })
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
		expect(use).not.toHaveBeenCalled()
	})

	it('a refused unseal (not_trusted, locked) passes its code and runs nothing', async () => {
		;(readWalletCredentialUnseal as jest.Mock).mockResolvedValueOnce({ kind: 'refused', code: 'not_trusted' })
		const use = jest.fn(async () => 'never')
		await expect(withShellOperationKey({ blob: 'sealed', expectedEoa: DERIVED.address }, use)).rejects.toMatchObject({ code: 'not_trusted' })
		expect(use).not.toHaveBeenCalled()
	})

	it('a malformed expected EOA is refused before anything is unsealed', async () => {
		await expect(withShellOperationKey({ blob: 'sealed', expectedEoa: 'not-an-address' }, async () => null)).rejects.toMatchObject({ code: 'bad_expected_eoa' })
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
	})
})
