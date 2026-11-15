/**
 * @jest-environment node
 *
 * Payment authorization key routing. Public zero-entropy vector only; no real key material. A refusal throws, so that no
 * caller can send a request with an empty payment header. The signer stands in for the payload builder: it is never called
 * on a refusal.
 */
jest.mock('./walletCredential', () => ({ readWalletCredentialUnseal: jest.fn() }))
jest.mock('./walletEoaAddress', () => ({ readWalletEoaAddress: jest.fn() }))
import { ethers } from 'ethers'
import { readWalletCredentialUnseal } from './walletCredential'
import { readWalletEoaAddress } from './walletEoaAddress'
import { AuthorizationSignRefusedError, isAuthorizationSignRefused, runAuthorizationSign } from './authorizationSign'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DERIVED = ethers.Wallet.fromPhrase(PHRASE)
const PROFILE_KEY = '0x' + '1'.repeat(64)
const EXPLICIT_KEY = '0x' + '2'.repeat(64)

function input(over: Partial<Parameters<typeof runAuthorizationSign>[0]> = {}) {
	const signWithKey = jest.fn(async (privateKey: string) => `signed:${privateKey}`)
	const readBlob = jest.fn(async () => 'sealed' as string | null)
	return {
		amount: 1n,
		to: '0x' + '9'.repeat(40),
		explicitKey: '',
		isShell: true,
		profileKey: '',
		readBlob,
		signWithKey,
		...over,
	}
}

beforeEach(() => {
	;(readWalletCredentialUnseal as jest.Mock).mockReset()
	;(readWalletEoaAddress as jest.Mock).mockReset()
	;(readWalletCredentialUnseal as jest.Mock).mockResolvedValue({ kind: 'credential', eoa: DERIVED.address.toLowerCase(), mnemonic: PHRASE, blob: null })
	;(readWalletEoaAddress as jest.Mock).mockResolvedValue({ kind: 'address', eoa: DERIVED.address })
})

describe('payment authorization key routing', () => {
	it('shell without an explicit key signs with the key unsealed for this call', async () => {
		const args = input()
		await expect(runAuthorizationSign(args)).resolves.toBe(`signed:${DERIVED.privateKey}`)
		expect(args.readBlob).toHaveBeenCalledTimes(1)
		expect(readWalletCredentialUnseal).toHaveBeenCalledWith('sealed')
		expect(args.signWithKey).toHaveBeenCalledTimes(1)
	})

	it('shell with a native refusal throws with the native code and never calls the signer', async () => {
		;(readWalletEoaAddress as jest.Mock).mockResolvedValueOnce({ kind: 'refused', code: 'locked' })
		const args = input()
		const run = runAuthorizationSign(args)
		await expect(run).rejects.toBeInstanceOf(AuthorizationSignRefusedError)
		await expect(run).rejects.toMatchObject({ code: 'locked' })
		expect(args.signWithKey).not.toHaveBeenCalled()
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
	})

	it('shell with a native EOA that differs from the unsealed phrase throws and never calls the signer', async () => {
		;(readWalletEoaAddress as jest.Mock).mockResolvedValueOnce({ kind: 'address', eoa: '0x' + '5'.repeat(40) })
		const args = input()
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'eoa_mismatch' })
		expect(args.signWithKey).not.toHaveBeenCalled()
	})

	it('shell with no blob in the page record throws and never unseals', async () => {
		const args = input({ readBlob: jest.fn(async () => null) })
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'no_blob' })
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
		expect(args.signWithKey).not.toHaveBeenCalled()
	})

	it('shell with an explicit key signs with that key and does not read the page record or ask native', async () => {
		const args = input({ explicitKey: EXPLICIT_KEY })
		await expect(runAuthorizationSign(args)).resolves.toBe(`signed:${EXPLICIT_KEY}`)
		expect(args.readBlob).not.toHaveBeenCalled()
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	it('browser uses the page profile key, with no shell operation', async () => {
		const args = input({ isShell: false, profileKey: PROFILE_KEY })
		await expect(runAuthorizationSign(args)).resolves.toBe(`signed:${PROFILE_KEY}`)
		expect(args.readBlob).not.toHaveBeenCalled()
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	it('browser with no key throws and never calls the signer', async () => {
		const args = input({ isShell: false })
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'no_key' })
		expect(args.signWithKey).not.toHaveBeenCalled()
		expect(readWalletEoaAddress).not.toHaveBeenCalled()
	})

	it('a signer failure inside a shell operation throws with the generic code', async () => {
		const args = input({ signWithKey: jest.fn(async () => { throw new Error('sign failed') }) })
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'error' })
	})

	it('an empty authorization from the signer throws, so no empty payment header is returned', async () => {
		const args = input({ isShell: false, profileKey: PROFILE_KEY, signWithKey: jest.fn(async () => '') })
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'sign_failed' })
	})
})

describe('the identity-blocked shell signs nothing', () => {
	it('a shell without the identity capability is refused before anything is unsealed or signed', async () => {
		const args = input({ identityBlocked: true })
		await expect(runAuthorizationSign(args)).rejects.toMatchObject({ code: 'identity_capability_missing' })
		expect(args.readBlob).not.toHaveBeenCalled()
		expect(readWalletCredentialUnseal).not.toHaveBeenCalled()
		expect(args.signWithKey).not.toHaveBeenCalled()
	})

	it('a browser is not blocked by the identity check (the flag is false outside a shell)', async () => {
		const args = input({ isShell: false, profileKey: PROFILE_KEY, identityBlocked: false })
		await expect(runAuthorizationSign(args)).resolves.toBe(`signed:${PROFILE_KEY}`)
	})
})

describe('refusal recognition for the page callers', () => {
	it('recognises the refusal by type and by name, and nothing else', () => {
		expect(isAuthorizationSignRefused(new AuthorizationSignRefusedError('locked'))).toBe(true)
		expect(isAuthorizationSignRefused(Object.assign(new Error('x'), { name: 'AuthorizationSignRefusedError' }))).toBe(true)
		expect(isAuthorizationSignRefused(new Error('network down'))).toBe(false)
		expect(isAuthorizationSignRefused(undefined)).toBe(false)
	})
})
