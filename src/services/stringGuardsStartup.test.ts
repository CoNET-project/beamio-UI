/**
 * @jest-environment node
 */
/**
 * String guards on the page's mnemonicPhrase at the readers that decide the startup or feed the sync channel (2026-11-22, ). A v3
 * envelope object, or any other shape, is never a plaintext phrase: no sync sends it, no startup reads it as an account, no key-only copy
 * decision takes it as absent.
 */
import { isNativeCopyValidated } from './copyValidatedEntry'
import { pageSyncPayload } from './shellMnemonicSync'
import { CRED_NAMES } from './identityPayload'
import { hasLocalPlaintextMnemonic, hasValidMnemonic, validMnemonicEoa } from '../utils/consumerWalletGate'
import { pageMnemonicField } from './pageMnemonicField'

const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const ENV = { v: 3, mode: 'passcode', eoa: EOA, kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: 'AAECAwQFBgcICQoLDA0ODw==', iv: 'AAECAwQFBgcICQoL', alg: 'AES-256-GCM', ct: 'AAAA' }
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('copy validation (copyValidatedEntry): an envelope in mnemonicPhrase is not a validated copy', () => {
	it('a native-validated copy whose field is the envelope object is not validated (no phrase is derived from it)', () => {
		const read = { status: 'loaded', copyValidated: true, data: { mnemonicPhrase: ENV, profiles: [{ keyID: EOA }] } } as never
		expect(isNativeCopyValidated(read, EOA)).toBe(false)
	})
})

describe('sync channel (pageSyncPayload): only a plaintext phrase string is ever sent', () => {
	it('an envelope object given as the phrase sends nothing', () => {
		expect(pageSyncPayload({ kind: 'valid', phrase: ENV as never, eoa: EOA })).toBeNull()
	})
	it('a plaintext phrase that derives the eoa is sent (control)', () => {
		expect(pageSyncPayload({ kind: 'valid', phrase: PHRASE, eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94' })).toEqual({
			phrase: PHRASE,
			eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
		})
	})
})

describe('account readers (consumerWalletGate): an envelope is neither a plaintext mnemonic nor a valid account credential here', () => {
	it('hasLocalPlaintextMnemonic, hasValidMnemonic and validMnemonicEoa all refuse the envelope object', () => {
		const data = { mnemonicPhrase: ENV } as never
		expect(hasLocalPlaintextMnemonic(data)).toBe(false)
		expect(hasValidMnemonic(data)).toBe(false)
		expect(validMnemonicEoa(data)).toBe('')
	})
	it('a plaintext phrase is still the valid account evidence (control)', () => {
		expect(validMnemonicEoa({ mnemonicPhrase: PHRASE } as never)).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94')
	})
})

describe('identity payload: the mnemonic field name is a credential name whatever its value', () => {
	it('mnemonicPhrase is in the credential names, so an identity payload never carries it (the envelope object included)', () => {
		expect(CRED_NAMES).toContain('mnemonicPhrase')
	})
})

describe('the gate classification (pageMnemonicField) of the envelope and other shapes', () => {
	it('the envelope is never a phrase; an unknown shape is never absent', () => {
		expect(pageMnemonicField({ mnemonicPhrase: ENV }).kind).toBe('envelope')
		expect(pageMnemonicField({ mnemonicPhrase: 42 }).kind).toBe('other')
	})
})
