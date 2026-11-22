/**
 * valid_mnemonic. The account evidence on the page is a valid mnemonic only.
 * A private key or an address on the record is not account evidence and never enters the home on its own.
 * Synthetic values only; the mnemonic predicate is injected so the test does not depend on a key derivation.
 */
import { idbSignalFromRecord, judgeShell, judgeBrowser } from './accountJudgement'

const HAS = { account: 'has_account', action: 'enter' }
const NO = { account: 'no_account', action: 'onboard' }
const UND = { account: 'undetermined', action: 'retry' }
const hasValid = (data: unknown) => (data as { mnemonicPhrase?: string } | null)?.mnemonicPhrase === 'valid-synthetic'

describe('M-1: a private key only record is not valid_mnemonic', () => {
	it('loaded record with a private key and no mnemonic is absent, never valid_mnemonic', () => {
		const idb = idbSignalFromRecord({ status: 'loaded', data: { mnemonicPhrase: '', keyPresent: 'synthetic-key' } }, hasValid)
		expect(idb).toBe('absent')
	})
	it('with native absent, a private-key-only record does not enter the home', () => {
		const idb = idbSignalFromRecord({ status: 'loaded', data: { mnemonicPhrase: '' } }, hasValid)
		expect(judgeShell(idb, 'absent')).not.toEqual(HAS)
	})
})

describe('M-2: a valid mnemonic record is valid_mnemonic and enters with native absent', () => {
	it('valid mnemonic maps to valid_mnemonic', () => {
		expect(idbSignalFromRecord({ status: 'loaded', data: { mnemonicPhrase: 'valid-synthetic' } }, hasValid)).toBe('valid_mnemonic')
	})
	it('valid_mnemonic with native absent enters', () => {
		expect(judgeShell('valid_mnemonic', 'absent')).toEqual(HAS)
	})
	it('valid_mnemonic in the browser enters', () => {
		expect(judgeBrowser('valid_mnemonic')).toEqual(HAS)
	})
})

describe('account_without_key with native absent stays undetermined (never absent, never enter)', () => {
	it('judgeShell account_without_key absent is undetermined', () => {
		expect(judgeShell('account_without_key', 'absent')).toEqual(UND)
	})
	it('empty store with native absent is onboarding (no_account), unchanged', () => {
		expect(judgeShell('absent', 'absent')).toEqual(NO)
	})
})
