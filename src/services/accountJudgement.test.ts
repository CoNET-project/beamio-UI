/**
 * Spec.6 and, run at run time. The IndexedDB and native signals are the ones the spec names.
 * is a sequence (the native store not ready, then present). SYNTHETIC values only.
 */
import { judgeBrowser, judgeShell, judgeShellFromNative, parsePasscodeStatus, idbSignalOf, recoverSourceOf, type NativeWalletState } from './accountJudgement'

const NO = { account: 'no_account', action: 'onboard' }
const HAS = { account: 'has_account', action: 'enter' }
const UND = { account: 'undetermined', action: 'retry' }
const UNLOCK = { account: 'undetermined', action: 'unlock' }

describe('browser: IndexedDB decides', () => {
	it('IndexedDB fully read, no key: no account', () => {
		expect(judgeBrowser('absent')).toEqual(NO)
	})
	it('IndexedDB did not open: undetermined, not onboarding', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable' }))).toEqual(UND)
	})
	it('IndexedDB read failed: undetermined, not onboarding', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'indexeddb' }))).toEqual(UND)
	})
	it('IndexedDB holds a valid EOA key: an existing account', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'loaded', keyPresent: true }))).toEqual(HAS)
	})
	it('the PGP record is missing but the EOA key exists: an existing account (PGP missing is not no wallet)', () => {
		// The signal carries no PGP field at all: the key decides.
		expect(judgeBrowser(idbSignalOf({ status: 'loaded', keyPresent: true, accountPresent: false }))).toEqual(HAS)
	})
	it('a completed BeamioTag without a key is undetermined, never onboarding', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'loaded', keyPresent: false, accountPresent: true }))).toEqual(UND)
	})
	it('a corrupt record is undetermined and is not overwritten by onboarding', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'unavailable', reason: 'invalid_document' }))).toEqual(UND)
	})
	it('a key without a BeamioTag is an existing account (it completes its profile, it is not created again)', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'loaded', keyPresent: true, accountPresent: false }))).toEqual(HAS)
	})
	it('the browser passcode record (locked) shows the passcode page, and is judged again after the unlock', () => {
		expect(judgeBrowser(idbSignalOf({ status: 'locked' }))).toEqual(UNLOCK)
	})
})

describe('shell: both sides decide', () => {
	it('both sides fully read and both absent: no account', () => {
		expect(judgeShell('absent', 'absent')).toEqual(NO)
	})
	it('IndexedDB absent, native not ready: undetermined, not onboarding', () => {
		expect(judgeShell('absent', 'not_ready')).toEqual(UND)
	})
	it('IndexedDB holds a key, native absent: an existing account', () => {
		expect(judgeShell('key', 'absent')).toEqual(HAS)
	})
	it('IndexedDB absent, native present (G1): an existing account', () => {
		expect(judgeShell('absent', 'present')).toEqual(HAS)
	})
	it('IndexedDB not fully read, native absent: undetermined (one side absent is not enough)', () => {
		expect(judgeShell('unfinished', 'absent')).toEqual(UND)
	})
	it('native not ready, then present: undetermined first, then an existing account; never onboarding on the way', () => {
		const sequence: Array<[Parameters<typeof judgeShell>[0], NativeWalletState]> = [
			['absent', 'not_ready'],
			['absent', 'not_ready'],
			['absent', 'present'],
		]
		const judged = sequence.map(([idb, native]) => judgeShell(idb, native))
		expect(judged[0]).toEqual(UND)
		expect(judged[1]).toEqual(UND)
		expect(judged[2]).toEqual(HAS)
		expect(judged.some((j) => j.action === 'onboard')).toBe(false)
	})
	it('native corrupt: undetermined; nothing is deleted, overwritten or created', () => {
		expect(judgeShell('absent', 'corrupt')).toEqual(UND)
		expect(judgeShell('unfinished', 'corrupt')).toEqual(UND)
	})
	it('native locked (iOS passcode lock): undetermined, the passcode page, judged again after the unlock', () => {
		expect(judgeShell('absent', 'locked')).toEqual(UNLOCK)
		expect(judgeShell('key', 'locked')).toEqual(UNLOCK)
	})
	it('covering upgrade, IndexedDB not read yet, native present: an existing account, not the create or restore page', () => {
		expect(judgeShell('unfinished', 'present')).toEqual(HAS)
	})
	it('covering upgrade, IndexedDB not read yet, native not ready: undetermined', () => {
		expect(judgeShell('unfinished', 'not_ready')).toEqual(UND)
	})
	it('the native unavailable state is undetermined on both sides', () => {
		expect(judgeShell('absent', 'unavailable')).toEqual(UND)
		expect(judgeShell('unavailable', 'absent')).toEqual(UND)
	})
})

describe('the passcodeStatus answer carries only set, locked, hasKey and walletState; no material', () => {
	it('the allowed keys are read, and walletState is the only state used for the judgement', () => {
		expect(parsePasscodeStatus({ set: true, locked: false, hasKey: true, walletState: 'present' })).toBe('present')
		expect(parsePasscodeStatus({ set: false, locked: false, hasKey: false, walletState: 'absent' })).toBe('absent')
	})
	it('an answer from a native build that does not report walletState yet: not_reported (the existing route applies)', () => {
		expect(parsePasscodeStatus({ set: false, locked: false, hasKey: true })).toBe('not_reported')
	})
	it('an extra field, or any material, refuses the answer: unknown (undetermined)', () => {
		expect(parsePasscodeStatus({ set: true, locked: false, hasKey: true, walletState: 'present', privateKeyHex: '0x00' })).toBe('unknown')
		expect(parsePasscodeStatus({ set: true, walletState: 'present', mnemonic: 'x' })).toBe('unknown')
	})
	it('an unknown walletState value, or a non-object answer: unknown (undetermined)', () => {
		expect(parsePasscodeStatus({ walletState: 'deleted' })).toBe('unknown')
		expect(parsePasscodeStatus(null)).toBe('unknown')
	})
})


describe('the page side of the pointer-empty judgement', () => {
	it('the pointer is empty and exactly one key is stored: walletState present, an existing account; the page enters on the native account', () => {
		// walletState present (G1), walletStatus unlocked with the account: enter. No IndexedDB record is needed.
		expect(judgeShellFromNative({ idb: 'unfinished', walletState: 'present', walletStatus: 'unlocked' })).toEqual(HAS)
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'present', walletStatus: 'not_ready' })).toEqual(HAS)
	})
	it('the pointer is empty and several keys are stored: walletState not_ready, undetermined; never onboarding, never the absent answer', () => {
		// walletStatus no_key must not turn a not_ready walletState into absent: the page reads walletState.
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_ready', walletStatus: 'no_key' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'unfinished', walletState: 'not_ready', walletStatus: 'not_ready' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'unavailable', walletStatus: 'no_key' })).toEqual(UND)
	})
	it('): the shell does not report walletState; walletStatus no_key is undetermined, never absent, never onboarding', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'unfinished', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'not_ready' })).toEqual(UND)
	})
	it('a valid IndexedDB key still makes an existing account on the not-reported route, and nothing else does', () => {
		expect(judgeShellFromNative({ idb: 'key', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(HAS)
		expect(judgeShellFromNative({ idb: 'account_without_key', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual(UND)
	})
})

describe('): the browser IndexedDB locked state shows the existing passcode page, judged again after the unlock', () => {
	it('a locked IndexedDB record is undetermined with the unlock action; never onboarding, never create or overwrite', () => {
		expect(judgeBrowser('locked')).toEqual(UNLOCK)
		expect(judgeBrowser(idbSignalOf({ status: 'locked' }))).toEqual(UNLOCK)
	})
})

describe('the account creation page never replaces a confirmed local key (overwrite estimate)', () => {
	it('a confirmed local key is reused: the EOA stays the same and the key is not replaced', () => {
		expect(recoverSourceOf({ status: 'loaded', keyPresent: true })).toBe('reuse_local')
	})
	it('a confirmed empty store is the only case where a new wallet is created', () => {
		expect(recoverSourceOf({ status: 'empty', keyPresent: false })).toBe('create_new')
	})
	it('a locked, unreadable or unconfirmed store is refused: nothing is created or overwritten', () => {
		expect(recoverSourceOf({ status: 'unavailable', keyPresent: false })).toBe('refuse')
		expect(recoverSourceOf({ status: 'locked', keyPresent: false })).toBe('refuse')
		expect(recoverSourceOf({ status: 'loaded', keyPresent: false })).toBe('refuse')
	})
})
