/**
 * 0.53.39: the one table of redacted reason codes for the start route and the shell wait paths.
 * Every code is a short, fixed token: it carries no key, no phrase, no ciphertext and no full address. The log line also carries the
 * request correlation id (reqId) when there is one, so a PWA log line can be paired with the native request it answers.
 * Only codes listed here are logged for these paths; a code not in this table is a bug (tested in startReasonCodes.test.ts).
 */
export const START_REASON_CODES = {
	pre_valid: 'a valid mnemonic from the native pre-read; the account is restored',
	confirmed_absent: 'both trusted sides confirm no valid mnemonic; onboarding',
	native_locked: 'the native passcode lock with no PWA mnemonic; retry with the unlock entry, never onboarding',
	pre_read_unsupported: 'an old shell without the pre-read command; the shell judgement decides, nothing waits',
	pre_unknown: 'the pre-read is unknown (timeout, bridge error or refused answer); retry',
	pre_read_not_ready: 'the native store answers not_ready to the pre-read (either answer shape); retry in the background, never onboarding',
	key_marker: 'a key marker is present without a mnemonic; retry, never onboarding',
	record_without_mnemonic: 'the native side reports a record that yields no valid mnemonic; retry',
	read_failed: 'a native or page read failed or is unreadable; unknown, retry',
	record_not_ready: 'the native record is not ready; retry',
	status_not_no_key: 'walletStatus is not no_key (for example not_ready while adoption settles); retry',
	key_only: 'walletStatus not_ready + key_only: address-only local home; page never deletes',
	bridge_trust_timeout: 'the native identity is not declared by the bridge-trust deadline; retry',
	page_read_failed: 'the page copy is unreadable; unknown, retry, nothing restored over the page',
	sealed_copy_unknown: 'the sealed-copy check is unknown; retry',
	bridge_trust_waiting: 'the native identity is not declared yet, before the bridge-trust deadline; waiting',
	child_frame_not_trusted: 'the page is not the trusted top frame; the native pre-read is not asked; waiting',
	pre_read_no_hold: 'the pre-read mnemonic cannot be held for this account; retry',
	passcode_not_provided: 'the native passcode is not provided: a pending-sync answer, not a landing decision; the landing stays with the page store and the pre-read; no screen, no button, no re-read, not counted, data kept',
	passcode_preread_inconsistent: 'a passcode account is reported while the pre-read answers absent: inconsistent with a passcode account (a passcode account pre-read should answer ok with ciphertext); no onboarding, data kept, background wait',
	pre_read_write_back_unconfirmed: 'the restored record is not confirmed on the page; retry, the next read asks again',
	record_unreadable: 'the pre-read read failed (read_error): unknown, data kept, never confirmed missing; retry in the background',
	preread_contradiction: 'the pre-read says absent but another record shows a key marker or ciphertext: redacted diagnostic, current re-read, data kept, no button',
	write_failed: 'the page write of a pre-read record failed or did not read back: data kept, retry in the background',
	storage_locked: 'the native storage is locked (not a decision): background re-read every 30 s after the schedule, data kept, no screen',
	ambiguous_accounts: 'the native store reports ambiguous accounts (not a decision): background re-read, data kept, no screen',
	not_ready_persistent: 'the native store stays not ready (persistent, not a decision): background re-read, data kept, no screen',
	unreadable_nonretryable: 'the record is unreadable and reported as non-retryable (not a decision): background re-read, data kept',
	native_retry_deadline: 'the splash deadline passed with the start undecided (shell): background re-read, no screen, no button',
	unlock_failed: 'a wrong passcode or a tampered record (GCM failed): counted on the passcode attempt store; the page stays',
	verify_failed: 'the record decrypted but does not match this account: not counted, nothing written, the page stays',
	cooldown_active: 'the passcode page is in its cooldown (persisted count): no decrypt is attempted until it ends',
	revert_unconfirmed: 'a reverted passcode count did not read back as written: the diagnostic is kept, nothing else changes',
	native_read_timeout: 'a native read did not answer within the 30 s cap: the start waits in the background; only the reqId is logged',
	late_result_adopted: 'a late native answer for the reqId the start still waits for, before any decision: adopted (verified, written, read back)',
	late_result_discarded: 'a late native answer that is not the one the start waits for (another reqId, or a decision already made): dropped',
	foreground_reread: 'the app returned to the foreground while the start waits: one immediate re-read (the schedule continues)',
	sync_retry: 'the background pwaWalletSync of a valid local record was not confirmed: retry on the re-read schedule, nothing written to the page',
} as const

export type StartReasonCode = keyof typeof START_REASON_CODES

export const isStartReasonCode = (code: string): code is StartReasonCode => Object.prototype.hasOwnProperty.call(START_REASON_CODES, code)

/** The log text for a reason code, with the correlation id when there is one. Never carries material. */
export const startReasonLine = (code: StartReasonCode, reqId?: number | string): string =>
	reqId === undefined ? `[start] reason=${code}` : `[start] reason=${code} reqId=${String(reqId)}`
