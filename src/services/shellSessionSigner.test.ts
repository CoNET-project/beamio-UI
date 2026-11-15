/**
 * @jest-environment node
 *
 * Shell page-session key. Public zero-entropy vector only; no real key material. Each test starts from an empty session.
 */
jest.mock('./walletCredential', () => ({ readWalletCredentialUnseal: jest.fn() }))
import { ethers } from 'ethers'
import { readWalletCredentialUnseal } from './walletCredential'
import { CoNET_Data, setCoNET_Data } from '../utils/globals'
import {
	clearShellSessionSigner,
	holdShellSessionFromPhrase,
	injectShellSessionKey,
	loadShellSessionSigner,
	shellSessionEoa,
	shellSessionPrivateKeyFor,
} from './shellSessionSigner'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const DERIVED = ethers.Wallet.fromPhrase(PHRASE)
const EOA = DERIVED.address.toLowerCase()
const OTHER = '0x' + '3'.repeat(40)

beforeEach(() => {
	clearShellSessionSigner()
	setCoNET_Data(null)
	;(readWalletCredentialUnseal as jest.Mock).mockReset()
	;(readWalletCredentialUnseal as jest.Mock).mockResolvedValue({ kind: 'credential', eoa: EOA, mnemonic: PHRASE, blob: null })
})

describe('shell page-session key', () => {
	it('holds the key derived from the unsealed phrase for the native account, and nothing for another account', async () => {
		await expect(loadShellSessionSigner('sealed', EOA)).resolves.toEqual({ kind: 'ok' })
		expect(shellSessionPrivateKeyFor(EOA)).toBe(DERIVED.privateKey)
		expect(shellSessionPrivateKeyFor(OTHER)).toBe('')
		expect(shellSessionEoa()).toBe(EOA)
	})

	it('a refused unseal holds nothing and reports the native code', async () => {
		;(readWalletCredentialUnseal as jest.Mock).mockResolvedValueOnce({ kind: 'refused', code: 'locked' })
		await expect(loadShellSessionSigner('sealed', EOA)).resolves.toEqual({ kind: 'refused', code: 'locked' })
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('an unsealed phrase that derives to another address fails closed and holds nothing', async () => {
		await expect(loadShellSessionSigner('sealed', OTHER)).resolves.toEqual({ kind: 'refused', code: 'eoa_mismatch' })
		expect(shellSessionPrivateKeyFor(OTHER)).toBe('')
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('a native answer for another account fails closed', async () => {
		;(readWalletCredentialUnseal as jest.Mock).mockResolvedValueOnce({ kind: 'credential', eoa: OTHER, mnemonic: PHRASE, blob: null })
		await expect(loadShellSessionSigner('sealed', EOA)).resolves.toEqual({ kind: 'refused', code: 'eoa_mismatch' })
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('a phrase that is not a valid mnemonic holds nothing', () => {
		expect(holdShellSessionFromPhrase('not a valid phrase at all', EOA)).toEqual({ kind: 'refused', code: 'bad_phrase' })
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('loading for a second account drops the first account key', async () => {
		await loadShellSessionSigner('sealed', EOA)
		;(readWalletCredentialUnseal as jest.Mock).mockResolvedValueOnce({ kind: 'refused', code: 'locked' })
		await loadShellSessionSigner('sealed', OTHER)
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
	})

	it('the key is put on the in-memory profile of the held account, and removed on clear', () => {
		setCoNET_Data({ profiles: [{ keyID: EOA }] } as never)
		holdShellSessionFromPhrase(PHRASE, EOA)
		expect(CoNET_Data?.profiles?.[0]?.privateKeyArmor).toBe(DERIVED.privateKey)
		clearShellSessionSigner()
		expect(shellSessionPrivateKeyFor(EOA)).toBe('')
		expect(CoNET_Data?.profiles?.[0]?.privateKeyArmor).toBe('')
	})

	it('the read path adds the held key to a copy of a record for the same account, and leaves other records alone', () => {
		holdShellSessionFromPhrase(PHRASE, EOA)
		const rec = { profiles: [{ keyID: EOA }], walletCredentialBlob: 'sealed' }
		const out = injectShellSessionKey(rec)
		expect(out).not.toBe(rec)
		expect(out.profiles[0]).toMatchObject({ keyID: EOA, privateKeyArmor: DERIVED.privateKey })
		expect(rec.profiles[0]).not.toHaveProperty('privateKeyArmor')
		const other = { profiles: [{ keyID: OTHER }] }
		expect(injectShellSessionKey(other)).toBe(other)
		const withKey = { profiles: [{ keyID: EOA, privateKeyArmor: '0x' + '1'.repeat(64) }] }
		expect(injectShellSessionKey(withKey)).toBe(withKey)
	})

	it('nothing is held without a session: the read path returns the record unchanged', () => {
		const rec = { profiles: [{ keyID: EOA }] }
		expect(injectShellSessionKey(rec)).toBe(rec)
	})

	it('the key is never written to browser storage', async () => {
		const setItem = jest.fn()
		;(globalThis as { localStorage?: unknown }).localStorage = { setItem, getItem: jest.fn(), removeItem: jest.fn() }
		;(globalThis as { sessionStorage?: unknown }).sessionStorage = { setItem, getItem: jest.fn(), removeItem: jest.fn() }
		await loadShellSessionSigner('sealed', EOA)
		holdShellSessionFromPhrase(PHRASE, EOA)
		clearShellSessionSigner()
		expect(setItem).not.toHaveBeenCalled()
		delete (globalThis as { localStorage?: unknown }).localStorage
		delete (globalThis as { sessionStorage?: unknown }).sessionStorage
	})
})
