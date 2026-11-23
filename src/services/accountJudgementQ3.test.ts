/**
 * Q3 (plan §四, C4(b), decision 2026-11-18). A private key or an address alone is not an account; a valid mnemonic is. Synthetic only.
 */
import { judgeShell, judgeShellFromNative } from './accountJudgement'
import { readFileSync } from 'fs'
import { join } from 'path'

const HAS = { account: 'has_account', action: 'enter' }

describe('Q3: a private-key-only record with native absent does not enter', () => {
	it('idb absent (no valid mnemonic) with native absent is onboarding evidence, never enter', () => {
		expect(judgeShell('absent', 'absent')).not.toEqual(HAS)
		expect(judgeShell('absent', 'absent')).toEqual({ account: 'no_account', action: 'onboard' })
	})
	it('valid_mnemonic with native absent enters (the only account evidence)', () => {
		expect(judgeShell('valid_mnemonic', 'absent')).toEqual(HAS)
	})
	it('native no_key with an empty-of-mnemonic store is the native no-key onboarding (storeEmpty = no valid mnemonic)', () => {
		expect(
			judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'no_key', storeEmpty: true }),
		).toEqual({ account: 'no_account', action: 'onboard', via: 'native_no_key' })
	})
});

describe('Q3: the shell no_account capability notice is removed from the gate', () => {
	const gate = readFileSync(join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
	it('the no-record entry no longer shows the capability notice', () => {
		expect(gate).not.toMatch(/no-record entry outside the native pre-read/)
	})
	it('storeEmpty is derived from the page holding no valid mnemonic', () => {
		expect(gate).toMatch(/storeEmpty: idb === 'absent'/)
	})
});
