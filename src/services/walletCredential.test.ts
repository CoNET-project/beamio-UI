/**
 * @jest-environment node
 *
 * `walletCredential`: the window channel only; the answer is read strictly; a `eoa_key` account is
 * unavailable; the page keeps the sealed blob only when its record is empty and the native address matches.
 * The phrases below are public BIP-39 test vectors (zero entropy); no key material.
 */
jest.mock('./shellRecordTransport', () => ({
	SHELL_RECORD_REPLY_TIMEOUT_MS: 10_000,
	sendWindowOnlyCommand: jest.fn(),
}))
jest.mock('./nativeChatRouteRegister', () => ({ nextReqId: () => 9 }))
import { sendWindowOnlyCommand } from './shellRecordTransport'
import {
	isMnemonicPhrase,
	pageCopyAction,
	parseWalletCredentialAnswer,
	readWalletCredential,
	readWalletCredentialUnseal,
	useMnemonicOnce,
	type WalletCredentialAnswer,
} from './walletCredential'

const EOA = '0x' + '6'.repeat(40)
const WORDS12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WORDS24 = ('abandon '.repeat(23) + 'art')
const ok = (result: Record<string, unknown>) => ({ type: 'ack', reqId: 9, ok: true, result })

describe('walletCredential answers are read strictly', () => {
	it('a mnemonic credential with its eoa and a sealed blob is accepted', () => {
		expect(parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: WORDS12, blob: 'opaque-blob' }))).toEqual({
			kind: 'credential',
			eoa: EOA,
			mnemonic: WORDS12,
			blob: 'opaque-blob',
		})
	})
	it('a 24-word phrase is accepted and the blob may be absent', () => {
		const r = parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: WORDS24 }))
		expect(r).toEqual({ kind: 'credential', eoa: EOA, mnemonic: WORDS24, blob: null })
	})
	it('an eoa_key account (no phrase) is unavailable: no private key is asked for', () => {
		expect(parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'eoa_key' }))).toEqual({ kind: 'refused', code: 'unavailable' })
	})
	it('a phrase with a wrong checksum, upper case, or a wrong length is a bad answer', () => {
		const badChecksum = WORDS12.replace(/about$/, 'abandon')
		expect(parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: badChecksum }))).toEqual({ kind: 'refused', code: 'bad_answer' })
		expect(parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: WORDS12.toUpperCase() }))).toEqual({ kind: 'refused', code: 'bad_answer' })
		expect(parseWalletCredentialAnswer(ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: WORDS12.split(' ').slice(1).join(' ') }))).toEqual({ kind: 'refused', code: 'bad_answer' })
	})
	it('a malformed eoa is a bad answer', () => {
		expect(parseWalletCredentialAnswer(ok({ eoa: '0xABC', credentialKind: 'mnemonic', mnemonic: WORDS12 }))).toEqual({ kind: 'refused', code: 'bad_answer' })
	})
	it('a refusal carries its code; a non-ack answer is a bad answer', () => {
		expect(parseWalletCredentialAnswer({ type: 'ack', reqId: 9, ok: false, error: 'not_trusted' })).toEqual({ kind: 'refused', code: 'not_trusted' })
		expect(parseWalletCredentialAnswer({ type: 'ready', reqId: 9, result: {} })).toEqual({ kind: 'refused', code: 'bad_answer' })
	})
	it('the phrase shape check accepts only the documented forms', () => {
		expect(isMnemonicPhrase(WORDS12)).toBe(true)
		expect(isMnemonicPhrase(WORDS24)).toBe(true)
		expect(isMnemonicPhrase('abandon')).toBe(false)
		expect(isMnemonicPhrase(undefined)).toBe(false)
	})
})

describe('walletCredential goes over the window channel and maps transport outcomes', () => {
	beforeEach(() => jest.clearAllMocks())

	it('the request carries only the type and the reqId; unseal adds the mode and the blob', async () => {
		;(sendWindowOnlyCommand as jest.Mock).mockResolvedValue({ kind: 'payload', payload: ok({ eoa: EOA, credentialKind: 'mnemonic', mnemonic: WORDS12 }) })
		await readWalletCredential()
		expect((sendWindowOnlyCommand as jest.Mock).mock.calls[0][0]).toEqual({ type: 'walletCredential', reqId: 9 })
		await readWalletCredentialUnseal('sealed')
		expect((sendWindowOnlyCommand as jest.Mock).mock.calls[1][0]).toEqual({ type: 'walletCredential', reqId: 9, mode: 'unseal', blob: 'sealed' })
	})
	it('origin refusal, a missing window channel, no channel and timeout are refusals with their codes', async () => {
		for (const kind of ['origin_refused', 'not_supported', 'none', 'timeout'] as const) {
			;(sendWindowOnlyCommand as jest.Mock).mockResolvedValueOnce({ kind })
			expect(await readWalletCredential()).toEqual({ kind: 'refused', code: kind })
		}
	})
})

describe('the page keeps the blob only when its record is empty', () => {
	const credential: WalletCredentialAnswer = { kind: 'credential', eoa: EOA, mnemonic: WORDS12, blob: 'sealed' }

	it('native ready and an empty page record: the blob is stored', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: credential })).toBe('store_blob')
	})
	it('a page record already present: nothing is asked for or stored', () => {
		expect(pageCopyAction({ pageRecordPresent: true, eoa: EOA, answer: credential })).toBe('none')
	})
	it('a credential for another account is never stored', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: '0x' + '7'.repeat(40), answer: credential })).toBe('retry')
	})
	it('a credential without a blob stores nothing and retries', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { ...credential, blob: null } })).toBe('retry')
	})
	it('not_trusted shows the update prompt; other refusals retry', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { kind: 'refused', code: 'not_trusted' } })).toBe('update_required')
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { kind: 'refused', code: 'unavailable' } })).toBe('retry')
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { kind: 'refused', code: 'locked' } })).toBe('retry')
	})
})

describe('the phrase is used once and passed on only for that use', () => {
	it('the use receives the phrase and returns its own result', () => {
		const credential = { kind: 'credential' as const, eoa: EOA, mnemonic: WORDS12, blob: null }
		expect(useMnemonicOnce(credential, (phrase) => phrase.split(' ').length)).toBe(12)
	})
})
