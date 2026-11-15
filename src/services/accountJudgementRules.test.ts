/**
 * Spec: a shell that does not report `walletState`(`not_reported`) is never an absent account.
 * A valid record on either side makes an existing account: (an IndexedDB EOA key) and (an old walletStatus `locked` or
 * `unlocked`, which the native layer reports only with the EOA). stays undetermined. SYNTHETIC inputs only; pure function layer.
 */
import { judgeShellFromNative, type IdbSignal, type NativeWalletStatus } from './accountJudgement'

const HAS = { account: 'has_account', action: 'enter' }
const UND = { account: 'undetermined', action: 'retry' }

describe('not_reported with a valid IndexedDB EOA key is an existing account', () => {
	it('key, no walletStatus signal (no_key) → has account', () => {
		expect(judgeShellFromNative({ idb: 'key', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(HAS)
	})
	it('key with any walletStatus → has account (the IndexedDB record is a valid record on its own)', () => {
		const statuses: NativeWalletStatus[] = ['no_key', 'not_ready', 'unknown', 'locked', 'unlocked']
		for (const walletStatus of statuses) {
			expect(judgeShellFromNative({ idb: 'key', walletState: 'not_reported', walletStatus })).toEqual(HAS)
		}
	})
})

describe('not_reported with an old walletStatus locked or unlocked (carries an EOA) is an existing account', () => {
	it('IndexedDB absent, walletStatus unlocked → has account, enter (not the passcode page)', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'unlocked' })).toEqual(HAS)
	})
	it('IndexedDB absent, walletStatus locked → has account, enter', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'locked' })).toEqual(HAS)
	})
	it('IndexedDB did not open (unavailable), walletStatus unlocked → has account (the native record is valid)', () => {
		expect(judgeShellFromNative({ idb: 'unavailable', walletState: 'not_reported', walletStatus: 'unlocked' })).toEqual(HAS)
	})
	it('IndexedDB unfinished, walletStatus locked → has account', () => {
		expect(judgeShellFromNative({ idb: 'unfinished', walletState: 'not_reported', walletStatus: 'locked' })).toEqual(HAS)
	})
})

describe('not_reported with nothing valid on either side stays undetermined', () => {
	it('IndexedDB absent, walletStatus no_key → undetermined, never absent', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
	})
	it('IndexedDB absent, walletStatus not_ready or unknown → undetermined', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'not_ready' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'unknown' })).toEqual(UND)
	})
	it('IndexedDB corrupt or account without key, walletStatus no_key → undetermined', () => {
		expect(judgeShellFromNative({ idb: 'corrupt', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'account_without_key', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
	})
	it('no not_reported combination without a valid record is ever absent', () => {
		const idbs: IdbSignal[] = ['absent', 'corrupt', 'unavailable', 'unfinished', 'locked', 'account_without_key']
		const statuses: NativeWalletStatus[] = ['no_key', 'not_ready', 'unknown']
		for (const idb of idbs) {
			for (const walletStatus of statuses) {
				const out = judgeShellFromNative({ idb, walletState: 'not_reported', walletStatus })
				expect(out.account).not.toBe('no_account')
			}
		}
	})
})
