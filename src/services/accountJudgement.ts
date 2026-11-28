/**
 * Account judgement at the entry gate (1– and).
 *
 * Only the EOA wallet private key decides whether an account exists. A PGP record missing is not a missing wallet. The native side reports
 * only its state (walletState), never material. The three answers:
 * - has_account: a valid record. Browser: the IndexedDB holds a valid EOA key. Shell: either side holds a valid record (IndexedDB, or the
 * native walletState `present`).
 * - no_account: CONFIRMED. Browser: IndexedDB fully read and absent. Shell: both sides fully read and both absent.
 * - undetermined: everything else. It never enters onboarding, never creates and never overwrites; the page retries. A native `locked`
 * state shows the existing passcode unlock page, and the account is judged again after the unlock.
 *
 * A completed BeamioTag without a key is undetermined, and a key without a BeamioTag is an existing account.
 * SYNTHETIC values only.
 */

/** The IndexedDB side, as the gate reads it. `unfinished`: the read has not finished. */
export type IdbSignal = 'valid_mnemonic' | 'absent' | 'account_without_key' | 'corrupt' | 'unavailable' | 'unfinished' | 'locked'

/** The native wallet state (`passcodeStatus.result.walletState`). */
export type NativeWalletState = 'present' | 'absent' | 'not_ready' | 'locked' | 'unavailable' | 'corrupt' | 'unknown'

export type JudgedAccount = 'has_account' | 'no_account' | 'undetermined'
/** What the gate does with the judgement: enter the app, show onboarding (create or restore), show the retry screen, or the passcode page. */
export type JudgedAction = 'enter' | 'onboard' | 'retry' | 'unlock'
export interface Judgement {
	account: JudgedAccount
	action: JudgedAction
	/** The rule that decided a no_account in a shell (R96): the native walletStatus no_key with an empty page store. */
	via?: 'native_no_key'
}

const UNDETERMINED: Judgement = { account: 'undetermined', action: 'retry' }

/** Browser (IndexedDB only). `valid_mnemonic` is the only account evidence: a private key or an address is never it (decision 2026-11-18). */
export const judgeBrowser = (idb: IdbSignal): Judgement => {
	if (idb === 'valid_mnemonic') return { account: 'has_account', action: 'enter' }
	if (idb === 'absent') return { account: 'no_account', action: 'onboard' }
	if (idb === 'locked') return { account: 'undetermined', action: 'unlock' }
	// An account without a key, a corrupt record, a database that did not open, a failed or unfinished read: not confirmed.
	return UNDETERMINED
}

/**
 * Shell (IndexedDB and the native wallet store), in the order of the spec table.
 * 1. a native `locked` state shows the passcode page; 2. a locked page store does the same (the page lock is not bypassed by a
 * native record); 3. native `present` enters; 4. (`not_reported`: see judgeShellFromNative); 5. native `not_ready`, `unavailable`,
 * `corrupt` and `unknown` keep the gate, whatever the page store holds (an IndexedDB private key does not open the app); 6. native `absent` is
 * judged by the page store: absent is no account, a valid mnemonic (`valid_mnemonic`) is an existing account; a private key alone is never this signal,
 * anything else is undetermined.
 */
export const judgeShell = (idb: IdbSignal, native: NativeWalletState): Judgement => {
	// 0.53.39 (project rule 2026-11-20): a valid PWA mnemonic enters /home whatever the native lock or readiness is. The native lock
	// only locks the native reads, writes and sync; it does not hold the PWA.
	if (idb === 'valid_mnemonic') return { account: 'has_account', action: 'enter' }
	if (native === 'locked') return { account: 'undetermined', action: 'unlock' }
	if (idb === 'locked') return { account: 'undetermined', action: 'unlock' }
	// 0.53.39: a native `present` is a record, not an account by itself. It enters only with a valid mnemonic
	// on the page (checked below); with none it is retry, never an account, never onboarding, never a new wallet.
	if (native === 'present') return UNDETERMINED
	if (native !== 'absent') return UNDETERMINED
	if (idb === 'absent') return { account: 'no_account', action: 'onboard' }
	return UNDETERMINED
}

/** The fields the `passcodeStatus` answer may carry. Anything else, and any material, refuses the answer. */
export const PASSCODE_STATUS_FIELDS: ReadonlySet<string> = new Set(['set', 'locked', 'hasKey', 'walletState', 'nativeLocked'])

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
	// nativeLocked: a boolean when present; any other value refuses the answer
	const nativeLocked = (result as { nativeLocked?: unknown }).nativeLocked
	if (nativeLocked !== undefined && typeof nativeLocked !== 'boolean') return 'unknown'
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
		if (read.keyPresent) return 'valid_mnemonic'
		if (read.accountPresent) return 'account_without_key'
		// Corrected: a document that loaded and parsed, with no key and no account record, is a successful read with no
		// mnemonic: IDB confirmed none (onboarding may proceed). An unparseable or structure-mismatched document is `corrupt` (unknown), below.
		return 'absent'
	}
	if (read.status === 'locked') return 'locked'
	if (read.status === 'empty') return 'absent'
	return read.reason === 'invalid_document' ? 'corrupt' : 'unavailable'
}

/**
 * The IndexedDB signal of a storage read, from the page record. Only a valid mnemonic is account evidence (`valid_mnemonic`); a private
 * key, an address or any other material on the record is `absent` (decision 2026-11-18, Q3 / C4). Pure: the caller passes the record.
 */
export const idbSignalFromRecord = (read: { status: 'loaded' | 'locked' | 'empty' | 'unavailable'; data?: unknown }, hasValid: (data: unknown) => boolean): IdbSignal => {
	const valid = read.status === 'loaded' && hasValid(read.data)
	return idbSignalOf({ status: read.status, keyPresent: valid, accountPresent: valid })
}

/** The walletStatus values the gate sees. */
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
	/** The page store read is a confirmed empty (R96): no mnemonic and no account on the page. */
	storeEmpty?: boolean
	/** The `passcodeStatus.hasKey` marker (0.53.39). `true` or `unknown` blocks the no_key onboarding; `not_reported` (older shell) does not. */
	hasKey?: boolean | 'not_reported' | 'unknown'
}): Judgement => {
	// 0.53.39 (rule 2026-11-20): a valid PWA mnemonic enters /home regardless of the native state.
	if (input.idb === 'valid_mnemonic') return { account: 'has_account', action: 'enter' }
	// R96: both sides confirm no account: the native side answers an explicit no_key (walletStatus), and the page
	// store is a confirmed empty read. Only the explicit no_key counts: G1 (not_ready), unknown and any other status never reach this rule.
	// 0.53.39: a key marker that is present, or unreadable, is not a confirmed absence: unknown, retry.
	if ((input.hasKey === true || input.hasKey === 'unknown') && input.walletStatus === 'no_key') {
		return UNDETERMINED
	}
	if (
		(input.walletState === 'absent' || input.walletState === 'not_reported') &&
		input.idb === 'absent' &&
		input.storeEmpty === true &&
		input.walletStatus === 'no_key'
	) {
		return { account: 'no_account', action: 'onboard', via: 'native_no_key' }
	}
	if (input.walletState !== 'not_reported') return judgeShell(input.idb, input.walletState)
	// the old native walletStatus reports an unlocked or locked wallet that carries an EOA.
	// LK-P6 : a locked G2 is the passcode lock, not an entry: the unlock branch. Only unlocked enters on the native account.
	if (input.walletStatus === 'locked') return { account: 'undetermined', action: 'unlock' }
	if (input.walletStatus === 'unlocked') return { account: 'has_account', action: 'enter' }
	// ( /): nothing valid on either side: undetermined, never absent.
	return UNDETERMINED
}

/**
 * Local mode. The entry rests on the native `notReadyReason` = `g1_uninitialized` (the native layer
 * proves that the record exists and is readable). Anything else keeps the gate: no field, `unreadable`, a locked or present state, or a
 * contradicting walletState. The EOA is for display only; it is never a basis for signing or identity.
 */
export type LocalOnlyDecision = 'enter_local' | 'keep_gate'
export const judgeLocalOnly = (input: {
	walletStatus: NativeWalletStatus
	notReadyReason?: 'g1_uninitialized' | 'key_only' | 'unreadable' | 'passcode_not_provided'
	walletState: NativeWalletState | 'not_reported'
}): LocalOnlyDecision => {
	if (input.walletStatus !== 'not_ready' || input.notReadyReason !== 'g1_uninitialized') return 'keep_gate'
	return input.walletState === 'not_ready' ? 'enter_local' : 'keep_gate'
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

/**
 * 0.53.39: what the start (and the shell no_key judgement) does with the native mnemonic pre-read, which covers the
 * native current record and the sealed copy. Only a confirmed absence is onboarding; a native lock is the passcode page; an unknown
 * (read failure, timeout, refused or unreadable answer) is retry, never onboarding and never a new wallet.
 */
export type NativeNoKeyRoute = 'onboard' | 'restore' | 'native_locked' | 'retry'
export const nativeNoKeyRoute = (pre: { kind: 'valid' } | { kind: 'absent' } | { kind: 'locked' } | { kind: 'unknown'; reason?: string } | { kind: string }): NativeNoKeyRoute => {
	if (pre.kind === 'valid') return 'restore'
	if (pre.kind === 'absent') return 'onboard'
	if (pre.kind === 'locked') return 'native_locked'
	return 'retry'
}

/**
 * 0.53.39: the native start route after the pre-read. Only a confirmed absence on every side is onboarding; a native
 * lock is the passcode page; an old shell without the pre-read command goes to the shell's own legacy judgement (nothing waits); every
 * other unknown is a retry with a redacted reason code. Input values are the answers as the gate reads them; no material is involved.
 */
export type NativeStartRoute = 'restore' | 'native_locked' | 'onboard' | 'retry' | 'legacy' | 'local'
export interface NativeStartOutcome {
	route: NativeStartRoute
	/** A redacted reason code for the log and the retry state. */
	reason: string
}
export const nativeStartRoute = (input: {
	pre: { kind: string; reason?: string }
	walletState: NativeWalletState | 'not_reported' | 'unknown' | 'timeout'
	hasKey: boolean | 'not_reported' | 'unknown'
	walletStatus: string
	/** Unit g (rev 2): walletStatus not_ready with passcode_not_provided: a pending sync, not a hold. Key and record guards above still apply. */
	passcodePending?: boolean
	/** When walletStatus is `not_ready`, the closed-set reason from the native answer. */
	notReadyReason?: string | null
}): NativeStartOutcome => {
	if (input.pre.kind === 'valid') return { route: 'restore', reason: 'pre_valid' }
	// 0.53.39 (rule 2026-11-20): a native lock with no PWA mnemonic is a retry state with an unlock entry; never onboarding.
	if (input.pre.kind === 'locked' || input.walletState === 'locked') return { route: 'native_locked', reason: 'native_locked' }
	// Unit g (the decision, 316.4 / 316.5): a ciphertext current record is the 'has' answer: it goes to the unlock page at once, and no other
	// source's passcode state (walletStatus and others) holds it back. Nothing is decrypted or written here.
	if (input.pre.kind === 'cipher') return { route: 'native_locked', reason: 'native_locked' }
	// an old shell that does not know the pre-read command: the legacy judgement (its hasKey and walletStatus rules still apply there)
	if (input.pre.kind === 'unknown' && input.pre.reason === 'unsupported') return { route: 'legacy', reason: 'pre_read_unsupported' }
	const readUnknown = input.walletState === 'unknown' || input.walletState === 'timeout' || input.hasKey === 'unknown' || input.walletStatus === 'unknown' || input.walletStatus === 'timeout' || input.walletStatus === 'unavailable'
	// Three classes of evidence: (i) every source says there is no valid mnemonic (`no_key` + absent pre): onboarding.
	// (ii) a real ciphertext record on any side is the unlock page (above, and passcodePending below). (iii) a read failure, or two evidences that
	// contradict each other, keeps the data and waits. walletStatus `not_ready` is never class (i) onboard — branch on notReadyReason:
	// `key_only` → local mode; any other not_ready → retry / startupWait.
	const recordPresentWithoutKey = input.walletState === 'present' && input.hasKey !== true
	if (input.pre.kind === 'absent' && input.passcodePending !== true && !readUnknown && !recordPresentWithoutKey) {
		if (input.walletStatus === 'not_ready') {
			if (input.notReadyReason === 'key_only') return { route: 'local', reason: 'key_only' }
			return { route: 'retry', reason: 'status_not_no_key' }
		}
		if (input.walletStatus === 'no_key' || input.walletStatus === undefined || input.walletStatus === '') {
			return { route: 'onboard', reason: 'confirmed_absent' }
		}
		// Other definite statuses with absent pre (unlocked / phrase_only / locked should have been decided earlier; fail closed).
		return { route: 'retry', reason: 'status_not_no_key' }
	}
	if (input.hasKey === true) return { route: 'retry', reason: 'key_marker' }
	if (input.pre.kind === 'unknown') return { route: 'retry', reason: 'pre_unknown' }
	// Unit g: a passcode account exists when any source reports passcode_not_provided. It is never a confirmed absence,
	// so an absent pre-read does not reach onboarding. The data is kept and the start waits in the background.
	if (input.passcodePending === true) return { route: 'retry', reason: 'passcode_not_provided' }
	// the pre-read is absent from here on
	if (input.walletState === 'present') return { route: 'retry', reason: 'record_without_mnemonic' }
	if (input.walletState === 'unknown' || input.walletState === 'timeout' || input.hasKey === 'unknown') {
		return { route: 'retry', reason: 'read_failed' }
	}
	if (input.walletState !== 'absent' && input.walletState !== 'not_reported') return { route: 'retry', reason: 'record_not_ready' }
	if (input.walletStatus === 'not_ready') {
		if (input.notReadyReason === 'key_only') return { route: 'local', reason: 'key_only' }
		return { route: 'retry', reason: 'status_not_no_key' }
	}
	if (input.walletStatus !== 'no_key') {
		return { route: 'retry', reason: input.walletStatus === 'unknown' || input.walletStatus === 'timeout' || input.walletStatus === 'unavailable' ? 'read_failed' : 'status_not_no_key' }
	}
	return { route: 'onboard', reason: 'confirmed_absent' }
}

/**
 * 0.53.39 (3): the bridge trust state while the native identity is not declared. A declared identity is trusted at any
 * time (a slow hello, for example 9.9 s on S25, is a wait that completes). Without it after the deadline the state is unknown, with the reason
 * `bridge_trust_timeout`: a retry state, never onboarding, never a new wallet.
 */
export const BRIDGE_TRUST_DEADLINE_MS = 20_000
export const bridgeTrustState = (input: { identity: string; elapsedMs: number }): { state: 'declared' | 'waiting' | 'unknown'; reason?: string } => {
	if (input.identity === 'declared') return { state: 'declared' }
	if (input.elapsedMs < BRIDGE_TRUST_DEADLINE_MS) return { state: 'waiting' }
	return { state: 'unknown', reason: 'bridge_trust_timeout' }
}

/**
 * 0.53.39 (A): the pre-read valid path and the page copy. A page copy that exists (loaded, locked or unavailable) is
 * checked by prepareShellEntry before the entry. An empty page is not checked: the native restore is written to the page by the restore write.
 */
export const prereadPageRoute = (pageStatus: 'loaded' | 'empty' | 'locked' | 'unavailable'): 'check_record' | 'restore_write' | 'wait_retry' => {
	if (pageStatus === 'empty') return 'restore_write'
	// 0.53.39 (2): an unreadable page is unknown: wait and retry. The page may still hold the user's wallet.
	if (pageStatus === 'unavailable') return 'wait_retry'
	return 'check_record'
}

/** The reason code for the bridge-trust wait (0.53.39 review): an unknown after the deadline is bridge_trust_timeout, otherwise waiting. */
export const bridgeTrustReasonCode = (state: 'declared' | 'waiting' | 'unknown'): 'bridge_trust_waiting' | 'bridge_trust_timeout' =>
	state === 'unknown' ? 'bridge_trust_timeout' : 'bridge_trust_waiting'
