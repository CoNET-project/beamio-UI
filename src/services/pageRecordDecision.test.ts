/**
 * @jest-environment node
 *
 * The page record against the native account. Public zero-entropy addresses only; no key material.
 */
import { decidePageRecord, type PageRecordRead } from './pageRecordDecision'

const EOA = '0x' + 'ab'.repeat(20)
const OTHER = '0x' + '2'.repeat(40)
const BLOB = 'sealed-credential-blob'
const ok = { kind: 'address' as const, eoa: EOA }
const loaded = (over: Record<string, unknown> = {}): PageRecordRead => ({
	status: 'loaded',
	data: { profiles: [{ keyID: EOA }], walletCredentialBlob: BLOB, ...over },
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

	it('a record with a sealed credential for the native account is used', () => {
		expect(decidePageRecord(loaded(), ok, EOA)).toBe('use')
	})

	it('a record with a page-held key for the native account is used', () => {
		expect(
			decidePageRecord({ status: 'loaded', data: { profiles: [{ keyID: EOA, privateKeyArmor: '0x' + '1'.repeat(64) }] } }, ok, EOA),
		).toBe('use')
	})

	it('a record for another account is eoa_mismatch (not used, not replaced)', () => {
		expect(decidePageRecord(loaded({ profiles: [{ keyID: OTHER }] }), ok, EOA)).toBe('eoa_mismatch')
	})

	it('a record with neither a sealed credential nor a key is a retry, not a copy', () => {
		expect(decidePageRecord(loaded({ walletCredentialBlob: '' }), ok, EOA)).toBe('retry')
	})
})

describe('shell record read: the main read path', () => {
	const { shellRecordReadState } = jest.requireActual<typeof import('./pageRecordDecision')>('./pageRecordDecision')
	const rec = { profiles: [{ keyID: EOA }], walletCredentialBlob: BLOB }

	it('a record for the native account with a credential is used', () => {
		expect(shellRecordReadState(rec, ok)).toEqual({ kind: 'use' })
	})

	it('a record for another account is eoa_mismatch on the read path, so no caller gets it', () => {
		expect(shellRecordReadState({ ...rec, profiles: [{ keyID: OTHER }] }, ok)).toEqual({ kind: 'unavailable', reason: 'eoa_mismatch' })
	})

	it('a refused or timed-out native account is native_retry on the read path, never used', () => {
		expect(shellRecordReadState(rec, { kind: 'refused', code: 'timeout' })).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})

	it('a record with no credential is native_retry, never used', () => {
		expect(shellRecordReadState({ profiles: [{ keyID: EOA }] }, ok)).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})
})

describe('native refusal codes on the page record decision', () => {
	const { shellRecordReadState: readState } = jest.requireActual<typeof import('./pageRecordDecision')>('./pageRecordDecision')
	const rec = { profiles: [{ keyID: EOA }], walletCredentialBlob: BLOB }

	it('not_trusted is an update prompt, on the entry and on the copy', () => {
		const refused = { kind: 'refused' as const, code: 'not_trusted' }
		expect(decidePageRecord({ status: 'empty' }, refused, EOA)).toBe('update_required')
		expect(decidePageRecord(loaded(), refused, EOA)).toBe('update_required')
		expect(readState(rec, refused)).toEqual({ kind: 'unavailable', reason: 'app_update_required' })
	})

	it('origin_refused is an origin error: a record-unavailable state, never an update prompt', () => {
		const refused = { kind: 'refused' as const, code: 'origin_refused' }
		expect(decidePageRecord({ status: 'empty' }, refused, EOA)).toBe('record_unavailable')
		expect(readState(rec, refused)).toEqual({ kind: 'unavailable', reason: 'native_record' })
	})

	it('any other refusal stays a retry', () => {
		expect(readState(rec, { kind: 'refused', code: 'locked' })).toEqual({ kind: 'unavailable', reason: 'native_retry' })
	})
})

