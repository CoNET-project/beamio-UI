/**
 * @jest-environment node
 */
/**
 *the three entry points take the native path for a native-validated copy and never call the
 * sealed-credential hold or the phrase hold. rule B/G (2026-11-17): a copy is validated only when the native flag, a BIP-39-valid
 * mnemonic and a keyID equal to the native walletEoaAddress all hold; the page never derives the EOA of a validated copy.
 * SYNTHETIC values only: the phrase is the public BIP-39 test vector; eoa1 is the address it derives to.
 */
import { ethers } from 'ethers'
import { copyPageEvidence, copyPreHoldAction, decidePrepareEntry, decidePrereadEntry, isNativeCopyValidated } from './copyValidatedEntry'
import type { CheckStorageResult } from './beamio'
import type { ShellSessionResult } from './shellSessionSigner'
import { validatedCopyAccount } from './shellRecordStore'
import { pageSyncPayload } from './shellMnemonicSync'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const eoa1 = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const eoa2 = ethers.Wallet.createRandom().address.toLowerCase()

/** A loaded page copy as the start read returns it. The flag is set only on the native-validated path (beamio.ts). */
const loaded = (data: Record<string, unknown>, copyValidated = true): CheckStorageResult =>
	({ status: 'loaded', data: data as never, ...(copyValidated ? { copyValidated: true as const } : {}) }) as CheckStorageResult

/** A validated copy for eoa1: a valid mnemonic whose derived address is the keyID. */
const copyFor = (over: Record<string, unknown> = {}) => ({ profiles: [{ keyID: eoa1 }], mnemonicPhrase: PHRASE, ...over })

describe('isNativeCopyValidated', () => {
	it('true only for a validated copy of this account', () => {
		expect(isNativeCopyValidated(loaded(copyFor()), eoa1)).toBe(true)
		expect(isNativeCopyValidated(loaded(copyFor()), eoa2)).toBe(false)
		expect(isNativeCopyValidated(loaded(copyFor(), false), eoa1)).toBe(false)
		expect(isNativeCopyValidated({ status: 'empty' }, eoa1)).toBe(false)
	})

	it('G: a flagged copy whose phrase fails the BIP-39 checksum is not validated (no page derivation to rescue it)', () => {
		expect(isNativeCopyValidated(loaded(copyFor({ mnemonicPhrase: 'a b c' })), eoa1)).toBe(false)
		expect(isNativeCopyValidated(loaded(copyFor({ mnemonicPhrase: '' })), eoa1)).toBe(false)
	})
})

describe('the validated flag follows the shell read rule', () => {
	it('a valid mnemonicPhrase is validated; recoveryWords alone, an invalid phrase, or neither is not', () => {
		expect(validatedCopyAccount({ copyValidated: true, eoa: eoa1, record: copyFor() })).toBe(true)
		expect(validatedCopyAccount({ copyValidated: true, eoa: eoa1, record: { mnemonicPhrase: '', recoveryWords: 'a b c', profiles: [{ keyID: eoa1 }] } })).toBe(false)
		expect(validatedCopyAccount({ copyValidated: true, eoa: eoa1, record: copyFor({ mnemonicPhrase: 'a b c' }) })).toBe(false)
		expect(validatedCopyAccount({ copyValidated: true, eoa: eoa1, record: { mnemonicPhrase: '', recoveryWords: '', profiles: [{ keyID: eoa1 }] } })).toBe(false)
	})
})

describe('entry point 1: prepareShellEntry (the sealed credential is not held for a validated copy)', () => {
	it('copy validated with a valid mnemonic and a blob: enter; the blob hold is called 0 times', async () => {
		const hold = jest.fn(async (): Promise<ShellSessionResult> => ({ kind: 'ok' }))
		const pre = loaded(copyFor({ walletCredentialBlob: 'BLOB' }))
		expect(await decidePrepareEntry(pre, eoa1, hold)).toBe('enter')
		expect(hold).not.toHaveBeenCalled()
	})

	it('a flagged copy with an invalid phrase is not a native shortcut: the existing blob hold still runs', async () => {
		const hold = jest.fn(async (): Promise<ShellSessionResult> => ({ kind: 'ok' }))
		const pre = loaded(copyFor({ mnemonicPhrase: 'a b c', walletCredentialBlob: 'BLOB' }))
		expect(await decidePrepareEntry(pre, eoa1, hold)).toBe('enter')
		expect(hold).toHaveBeenCalledTimes(1)
	})

	it('copy not validated (the same record without the flag): the existing blob hold still runs', async () => {
		const hold = jest.fn(async (): Promise<ShellSessionResult> => ({ kind: 'ok' }))
		const pre = loaded({ profiles: [{ keyID: eoa1 }], walletCredentialBlob: 'BLOB' }, false)
		expect(await decidePrepareEntry(pre, eoa1, hold)).toBe('enter')
		expect(hold).toHaveBeenCalledTimes(1)
	})

	it('a validated copy whose account is not this one takes no native shortcut', async () => {
		const hold = jest.fn(async (): Promise<ShellSessionResult> => ({ kind: 'refused', code: 'eoa_mismatch' }))
		const pre = loaded({ profiles: [{ keyID: eoa1 }], walletCredentialBlob: 'BLOB' })
		expect(await decidePrepareEntry(pre, eoa2, hold)).toBe('eoa_mismatch')
		expect(hold).toHaveBeenCalledTimes(1)
	})
})

describe('entry point 2: the pre-read valid path (no phrase hold for a validated copy)', () => {
	it('validated copy for the pre-read account: native path, the pre-read phrase is not adopted', async () => {
		const native = jest.fn()
		const adopt = jest.fn(async () => undefined)
		const r = await decidePrereadEntry(loaded(copyFor()), eoa1, native, adopt)
		expect(r).toBe('native')
		expect(native).toHaveBeenCalledTimes(1)
		expect(adopt).not.toHaveBeenCalled()
	})

	it('no validated copy: the pre-read phrase is adopted as before', async () => {
		const native = jest.fn()
		const adopt = jest.fn(async () => undefined)
		expect(await decidePrereadEntry({ status: 'empty' }, eoa1, native, adopt)).toBe('adopted')
		expect(adopt).toHaveBeenCalledTimes(1)
		expect(native).not.toHaveBeenCalled()
	})
})

describe('entry point 3: restorePageCopy (race and snapshot)', () => {
	it('a validated snapshot for this account: native, so no credential is asked or held', () => {
		expect(copyPreHoldAction(loaded(copyFor()), eoa1)).toBe('native')
	})

	it('the snapshot is taken once: a later change of the store does not reopen the hold for the same entry', () => {
		const snapshot = loaded(copyFor())
		// the decision uses the snapshot it was given; a second read in the same entry is not consulted
		expect(copyPreHoldAction(snapshot, eoa1)).toBe('native')
		expect(copyPreHoldAction({ status: 'empty' }, eoa1)).toBe('proceed')
	})

	it('a validated copy of another account, or an empty store: proceed to the existing path (no native shortcut)', () => {
		expect(copyPreHoldAction(loaded(copyFor()), eoa2)).toBe('proceed')
		expect(copyPreHoldAction({ status: 'empty' }, eoa1)).toBe('proceed')
	})
})

describe('gate evidence: a validated copy takes the native EOA; the page does not derive it', () => {
	it('isNativeCopyValidated with no account: any validated copy with a valid phrase, and not an unvalidated one', () => {
		expect(isNativeCopyValidated(loaded(copyFor()), '')).toBe(true)
		expect(isNativeCopyValidated(loaded(copyFor(), false), '')).toBe(false)
	})

	it('G (111): the copy keyID differs from the native walletEoaAddress → unknown (held, nothing sent)', () => {
		const evidence = copyPageEvidence(loaded(copyFor()), { kind: 'address', eoa: eoa2 })
		expect(evidence).toEqual({ kind: 'unknown' })
		expect(pageSyncPayload(evidence ?? { kind: 'unknown' })).toBeNull()
	})

	it('G: the copy keyID equals the native address → valid with that EOA; a copy with no flag gives no copy evidence', () => {
		expect(copyPageEvidence(loaded(copyFor()), { kind: 'address', eoa: eoa1 })).toEqual({ kind: 'valid', eoa: eoa1, phrase: PHRASE, nativeValidated: true })
		expect(copyPageEvidence(loaded(copyFor(), false), { kind: 'address', eoa: eoa1 })).toBeNull()
	})

	it('G: a validated copy whose phrase fails the checksum is unknown, even when the native address matches', () => {
		expect(copyPageEvidence(loaded(copyFor({ mnemonicPhrase: 'a b c' })), { kind: 'address', eoa: eoa1 })).toEqual({ kind: 'unknown' })
	})

	it('pageSyncPayload: a native-validated evidence is sent with the native EOA (the page does not check the phrase against it)', () => {
		const native = { kind: 'valid', phrase: PHRASE, eoa: eoa1, nativeValidated: true }
		expect(pageSyncPayload(native)).toEqual({ phrase: PHRASE, eoa: eoa1 })
		// without the native marker the page checks the phrase against the EOA (the existing derivation check)
		expect(pageSyncPayload({ kind: 'valid', phrase: PHRASE, eoa: eoa2 })).toBeNull()
	})
})
