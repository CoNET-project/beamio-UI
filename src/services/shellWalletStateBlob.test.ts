/**
 * @jest-environment node
 *
 * A shell record with only a sealed credential (no page-held key) is a usable record: the native layer unseals it for one operation, and
 * the account is checked at that use. Public zero-entropy address only; no key material.
 */
import { shellRecordAsWalletRecord, type ShellRecordRead } from './shellRecordStore'
import { shellWalletState } from './shellRecordSanitizer'

const ACCOUNT = '0x' + '1'.repeat(40)
const BLOB = 'sealed-credential-blob'

const blobOnly = (over: Record<string, unknown> = {}) => ({
	profiles: [{ keyID: ACCOUNT, privateKeyArmor: '', publicKeyArmor: '' }],
	walletCredentialBlob: BLOB,
	...over,
})

describe('shell record with only a sealed credential', () => {
	it('is ok: the blob is the EOA source, and nothing is held in plaintext', () => {
		expect(shellWalletState(blobOnly())).toBe('ok')
	})

	it('reads as a wallet record (no hold)', () => {
		const read = { status: 'ok', record: blobOnly(), rev: 1, walletFieldsRedacted: false } as unknown as ShellRecordRead
		expect(shellRecordAsWalletRecord(read)).toEqual(blobOnly())
	})

	it('a blank blob is not a credential: needs native recovery, never absent', () => {
		expect(shellWalletState(blobOnly({ walletCredentialBlob: '   ' }))).toBe('needs_native_recovery')
	})

	it('no blob and no key stays needs native recovery', () => {
		expect(shellWalletState({ profiles: [{ keyID: ACCOUNT, privateKeyArmor: '' }] })).toBe('needs_native_recovery')
	})

	it('a damaged account address is a hold even with a blob', () => {
		expect(shellWalletState(blobOnly({ profiles: [{ keyID: '0xnothex' }] }))).toBe('wallet_fields_missing')
	})

	it('two profiles bound to the account are a hold even with a blob', () => {
		expect(
			shellWalletState(
				blobOnly({ profiles: [{ keyID: ACCOUNT }, { keyID: ACCOUNT }] }),
			),
		).toBe('duplicate_profiles')
	})
})
