/**
 *a shell is no_account only when both sides confirm: the explicit native walletStatus no_key, and the page
 * store is a confirmed empty read. G1 (not_ready), unknown and every other status never decide no_account here. SYNTHETIC values only.
 */
import { judgeShellFromNative } from './accountJudgement'

const base = { idb: 'absent' as const, walletState: 'not_reported' as const, walletStatus: 'no_key' as const, storeEmpty: true }

describe('the native no_key rule in the shell judgement', () => {
	it('explicit no_key and an empty page store: no_account via the native rule (onboarding)', () => {
		expect(judgeShellFromNative(base)).toEqual({ account: 'no_account', action: 'onboard', via: 'native_no_key' })
	})

	it('walletState absent with the same inputs: also the native rule', () => {
		expect(judgeShellFromNative({ ...base, walletState: 'absent' })).toEqual({ account: 'no_account', action: 'onboard', via: 'native_no_key' })
	})

	it('G1 (walletStatus not_ready) is never no_account here, even with an empty page', () => {
		expect(judgeShellFromNative({ ...base, walletStatus: 'not_ready' }).account).toBe('undetermined')
	})

	it('unknown walletStatus is never no_account', () => {
		expect(judgeShellFromNative({ ...base, walletStatus: 'unknown' }).account).toBe('undetermined')
	})

	it('no confirmed empty page store: undetermined (the start state), not no_account', () => {
		expect(judgeShellFromNative({ ...base, storeEmpty: false }).account).toBe('undetermined')
		expect(judgeShellFromNative({ ...base, storeEmpty: undefined }).account).toBe('undetermined')
	})

	it('a native account present (walletState present) is never no_account from the rule', () => {
		expect(judgeShellFromNative({ ...base, walletState: 'present' as never }).account).not.toBe('no_account')
	})

	it('a page store with an IndexedDB key is has_account, never no_account', () => {
		expect(judgeShellFromNative({ ...base, idb: 'valid_mnemonic' }).account).toBe('has_account')
	})
})
