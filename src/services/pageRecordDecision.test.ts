/**
 * @jest-environment node
 *
 * The page record against the native account. SYNTHETIC values only: the phrase is the public BIP-39 test vector, and the native EOA is the
 * address it derives to. rule A (2026-11-17): a readable valid mnemonic is use; a readable key or address is not an account (not_account, the
 * pre-read decides); a sealed credential whose content is not readable here is a retry (hold until it unlocks).
 */
import { decidePageRecord, shellRecordReadState, type PageRecordRead } from './pageRecordDecision'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER = '0x' + '2'.repeat(40)
const BLOB = 'sealed-credential-blob'
const ok = { kind: 'address' as const, eoa: EOA }
const KEY = '0x' + '1'.repeat(64)

const loaded = (over: Record<string, unknown> = {}): PageRecordRead => ({
	status: 'loaded',
	data: { profiles: [{ keyID: EOA }], mnemonicPhrase: PHRASE, ...over },
})

describe('page record decision', () => {
	it('a refused, timed-out or unavailable native account is a retry for every record, never an absent wallet', () => {
		const refused = { kind: 'refused' as const, code: 'timeout' }
		expect(decidePageRecord({ status: 'empty' }, refused, EOA)).toBe('retry')
		expect(decidePageRecord(loaded(), refused, EOA)).toBe('retry')
		expect(decidePageRecord({ status: 'other' }, refused, EOA)).toBe('retry')
	})

	it('a native account that differs from the account this start entered is a retry', () => {
		expect(decidePageRecord(loaded(), { kind: 'address', eoa: OTHER }, EOA)).toBe('retry')
	})

	it('an unavailable or locked store is a retry, never empty', () => {
		expect(decidePageRecord({ status: 'other' }, ok, EOA)).toBe('retry')
	})

	it('an empty store with a native account allows the copy', () => {
		expect(decidePageRecord({ status: 'empty' }, ok, EOA)).toBe('empty')
	})

	it('A: a readable valid mnemonic whose derived EOA is the keyID and the native account is use', () => {
		expect(decidePageRecord(loaded(), ok, EOA)).toBe('use')
	})

	it('A: a readable key without a mnemonic is not an account (not_account, the pre-read decides), and nothing is used', () => {
		expect(decidePageRecord({ status: 'loaded', data: { profiles: [{ keyID: EOA, privateKeyArmor: KEY }] } }, ok, EOA)).toBe('not_account')
	})

	it('A: a readable address without a mnemonic or key is not an account (not_account)', () => {
		expect(decidePageRecord({ status: 'loaded', data: { profiles: [{ keyID: EOA }] } }, ok, EOA)).toBe('not_account')
	})

	it('C (page-local): a plaintext mnemonic that does not derive to the keyID is not an account (not_account), never used', () => {
		expect(decidePageRecord(loaded({ mnemonicPhrase: 'w w w' }), ok, EOA)).toBe('not_account')
	})

	it('D (provisional): a sealed credential whose content is not readable here is a hold (retry), never used', () => {
		expect(decidePageRecord({ status: 'loaded', data: { profiles: [{ keyID: EOA }], walletCredentialBlob: BLOB } }, ok, EOA)).toBe('retry')
	})

	it('a record for another account is eoa_mismatch (not used, not replaced)', () => {
		expect(decidePageRecord(loaded({ profiles: [{ keyID: OTHER }] }), ok, EOA)).toBe('eoa_mismatch')
	})
})

describe('shell record read: the main read path', () => {
	const rec = { profiles: [{ keyID: EOA }], mnemonicPhrase: PHRASE }

	it('A: a record with a valid mnemonic for the native account is used', () => {
		expect(shellRecordReadState(rec, ok)).toEqual({ kind: 'use' })
	})

	it('a record for another account is eoa_mismatch on the read path, so no caller gets it', () => {
		expect(shellRecordReadState({ ...rec, profiles: [{ keyID: OTHER }] }, ok)).toEqual({ kind: 'unavailable', reason: 'eoa_mismatch' })
	})

	it('a refused or timed-out native account is native_retry on the read path, never used', () => {
		expect(shellRecordReadState(rec, { kind: 'refused', code: 'timeout' })).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})

	it('D: a sealed credential (the native-sealed phrase, waiting for unlock) is a hold on the read path, never onboarding', () => {
		expect(shellRecordReadState({ profiles: [{ keyID: EOA }], walletCredentialBlob: BLOB }, ok)).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})

	it('A: a key-only or address-only record is not_account on the read path (never used; nothing is written)', () => {
		expect(shellRecordReadState({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }] }, ok)).toEqual({ kind: 'not_account' })
		expect(shellRecordReadState({ profiles: [{ keyID: EOA }] }, ok)).toEqual({ kind: 'not_account' })
	})
})

describe('native refusal codes on the page record decision', () => {
	const rec = { profiles: [{ keyID: EOA }], mnemonicPhrase: PHRASE }

	it('not_trusted is an update prompt, on the entry and on the copy', () => {
		const refused = { kind: 'refused' as const, code: 'not_trusted' }
		expect(decidePageRecord({ status: 'empty' }, refused, EOA)).toBe('update_required')
		expect(decidePageRecord(loaded(), refused, EOA)).toBe('update_required')
		expect(shellRecordReadState(rec, refused)).toEqual({ kind: 'unavailable', reason: 'app_update_required' })
	})

	it('origin_refused is an origin error: a record-unavailable state, never an update prompt', () => {
		const refused = { kind: 'refused' as const, code: 'origin_refused' }
		expect(decidePageRecord({ status: 'empty' }, refused, EOA)).toBe('record_unavailable')
		expect(shellRecordReadState(rec, refused)).toEqual({ kind: 'unavailable', reason: 'native_record' })
	})

	it('any other refusal stays a retry', () => {
		expect(shellRecordReadState(rec, { kind: 'refused', code: 'locked' })).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})
})
