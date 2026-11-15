/**
 * Account judgement at the entry gate (1– and).
 *
 * Only the EOA wallet private key decides whether an account exists. A PGP record missing is not a missing wallet. The native side reports
 * only its state (walletState), never material. The three answers:
 * - has_account: a valid record. Browser: the IndexedDB holds a valid EOA key. Shell: either side holds a valid record (IndexedDB, or the
 *   native walletState `present`).
 * - no_account: CONFIRMED. Browser: IndexedDB fully read and absent. Shell: both sides fully read and both absent.
 * - undetermined: everything else. It never enters onboarding, never creates and never overwrites; the page retries. A native `locked`
 * state shows the existing passcode unlock page, and the account is judged again after the unlock.
 *
 * A completed BeamioTag without a key is undetermined, and a key without a BeamioTag is an existing account.
 * SYNTHETIC values only.
 */

/** The IndexedDB side, as the gate reads it. `unfinished`: the read has not finished. */
export type IdbSignal = 'key' | 'absent' | 'account_without_key' | 'corrupt' | 'unavailable' | 'unfinished' | 'locked'

/** The native wallet state (`passcodeStatus.result.walletState`). */
export type NativeWalletState = 'present' | 'absent' | 'not_ready' | 'locked' | 'unavailable' | 'corrupt' | 'unknown'

export type JudgedAccount = 'has_account' | 'no_account' | 'undetermined'
/** What the gate does with the judgement: enter the app, show onboarding (create or restore), show the retry screen, or the passcode page. */
export type JudgedAction = 'enter' | 'onboard' | 'retry' | 'unlock'
export interface Judgement {
	account: JudgedAccount
	action: JudgedAction
}

const UNDETERMINED: Judgement = { account: 'undetermined', action: 'retry' }

/** Browser (IndexedDB only). */
export const judgeBrowser = (idb: IdbSignal): Judgement => {
	if (idb === 'key') return { account: 'has_account', action: 'enter' }
	if (idb === 'absent') return { account: 'no_account', action: 'onboard' }
	if (idb === 'locked') return { account: 'undetermined', action: 'unlock' }
	// An account without a key, a corrupt record, a database that did not open, a failed or unfinished read: not confirmed.
	return UNDETERMINED
}

/**
 * Shell (IndexedDB and the native wallet store). A native `locked` state is not a basis for either answer: the passcode page is shown,
 * and the judgement is made again after the unlock.
 */
export const judgeShell = (idb: IdbSignal, native: NativeWalletState): Judgement => {
	if (native === 'locked') return { account: 'undetermined', action: 'unlock' }
	if (idb === 'key' || native === 'present') return { account: 'has_account', action: 'enter' }
	if (idb === 'absent' && native === 'absent') return { account: 'no_account', action: 'onboard' }
	// A single side absent is not enough for no account; not ready, unavailable, corrupt, unfinished: undetermined (retry).
	return UNDETERMINED
}

/** The fields the `passcodeStatus` answer may carry. Anything else, and any material, refuses the answer. */
export const PASSCODE_STATUS_FIELDS: ReadonlySet<string> = new Set(['set', 'locked', 'hasKey', 'walletState'])

const WALLET_STATES: ReadonlySet<string> = new Set(['present', 'absent', 'not_ready', 'locked', 'unavailable', 'corrupt'])

/**
 * Reads `walletState` from a `passcodeStatus` result. Returns `not_reported` when the native answer has no `walletState` (a native build that
 * does not report it yet: the gate then keeps the existing route, see the gate). A refused answer (an extra field, or any key that carries
 * material) is `unknown`, which is undetermined.
 */
export const parsePasscodeStatus = (result: unknown): NativeWalletState | 'not_reported' => {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown'
	const keys = Object.keys(result as Record<string, unknown>)
	if (keys.some((k) => !PASSCODE_STATUS_FIELDS.has(k))) return 'unknown'
	const state = (result as { walletState?: unknown }).walletState
	if (state === undefined) return 'not_reported'
	if (typeof state !== 'string' || !WALLET_STATES.has(state)) return 'unknown'
	return state as NativeWalletState
}

/** Maps a storage read to the IndexedDB signal. `keyPresent` / `accountPresent` describe a loaded record. */
export const idbSignalOf = (read: {
	status: 'loaded' | 'locked' | 'empty' | 'unavailable'
	keyPresent?: boolean
	accountPresent?: boolean
	reason?: string
}): IdbSignal => {
	if (read.status === 'loaded') {
		if (read.keyPresent) return 'key'
		if (read.accountPresent) return 'account_without_key'
		return 'corrupt'
	}
	if (read.status === 'locked') return 'locked'
	if (read.status === 'empty') return 'absent'
	return read.reason === 'invalid_document' ? 'corrupt' : 'unavailable'
}

/** The walletStatus values the gate sees (W1). */
export type NativeWalletStatus = 'no_key' | 'not_ready' | 'unknown' | 'locked' | 'unlocked'

/**
 * Shell judgement from both native answers.
 * `walletState` is the only basis when it is reported. A build that does not report it (`not_reported`) is never an absent account
 * (undetermined,: walletStatus `no_key`is not an absence proof). A valid record on either side makes an existing
 * account: an IndexedDB EOA key, or an old walletStatus `locked`/ `unlocked`. The native layer reports these
 * two statuses only together with the account's EOA (`NativeWalletState` in nativeRecovery.ts), so the status alone is the record.
 * No new wallet is created on this route.
 */
export const judgeShellFromNative = (input: {
	idb: IdbSignal
	walletState: NativeWalletState | 'not_reported'
	walletStatus: NativeWalletStatus
}): Judgement => {
	if (input.walletState !== 'not_reported') return judgeShell(input.idb, input.walletState)
	// a valid IndexedDB EOA key.
	if (input.idb === 'key') return { account: 'has_account', action: 'enter' }
	// the old native walletStatus reports an unlocked or locked wallet that carries an EOA.
	if (input.walletStatus === 'locked' || input.walletStatus === 'unlocked') return { account: 'has_account', action: 'enter' }
	// ( /): nothing valid on either side: undetermined, never absent.
	return UNDETERMINED
}

/** How the account creation page takes its wallet (overwrite estimate). A confirmed local key is reused, never replaced. */
export type RecoverSource = 'reuse_local' | 'create_new' | 'refuse'

export const recoverSourceOf = (local: {
	status: 'loaded' | 'locked' | 'empty' | 'unavailable'
	keyPresent: boolean
}): RecoverSource => {
	if (local.status === 'loaded' && local.keyPresent) return 'reuse_local'
	// A new wallet is created only when the store is confirmed empty. A locked, unreadable or unconfirmed store is refused: it is never replaced.
	if (local.status === 'empty') return 'create_new'
	return 'refuse'
}

/**
 * Split rule: a browser account that holds a key and the recovery phrase, but no completed BeamioTag, goes straight to the Create Beamio ID page
 * (no new / restore choice page). The shell keeps its own route (the native side holds the key and owns creation).
 */
export const beamioTagCreateNeeded = (input: {
	shell: boolean
	presence: JudgedAccount
	completedAccount: boolean
	/** only a record that holds the recovery phrase opens the create page; a key-only record follows the existing route. */
	hasMnemonic: boolean
}): boolean => !input.shell && input.presence === 'has_account' && !input.completedAccount && input.hasMnemonic

/**
 * a page opened to reuse the existing key may never create a new wallet. `create_new`is allowed only without that flag;
 * `refuse` is never allowed.
 */
export const recoverAllowed = (source: RecoverSource, mustReuseKey: boolean): boolean =>
	source === 'reuse_local' || (!mustReuseKey && source === 'create_new')
