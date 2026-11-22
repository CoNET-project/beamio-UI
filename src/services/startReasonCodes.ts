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
	key_marker: 'a key marker is present without a mnemonic; retry, never onboarding',
	record_without_mnemonic: 'the native side reports a record that yields no valid mnemonic; retry',
	read_failed: 'a native or page read failed or is unreadable; unknown, retry',
	record_not_ready: 'the native record is not ready; retry',
	status_not_no_key: 'walletStatus is not no_key (for example not_ready while adoption settles); retry',
	bridge_trust_timeout: 'the native identity is not declared by the bridge-trust deadline; retry',
	page_read_failed: 'the page copy is unreadable; unknown, retry, nothing restored over the page',
	sealed_copy_unknown: 'the sealed-copy check is unknown; retry',
	bridge_trust_waiting: 'the native identity is not declared yet, before the bridge-trust deadline; waiting',
	child_frame_not_trusted: 'the page is not the trusted top frame; the native pre-read is not asked; waiting',
	pre_read_no_hold: 'the pre-read mnemonic cannot be held for this account; retry',
	pre_read_write_back_unconfirmed: 'the restored record is not confirmed on the page; retry, the next read asks again',
} as const

export type StartReasonCode = keyof typeof START_REASON_CODES

export const isStartReasonCode = (code: string): code is StartReasonCode => Object.prototype.hasOwnProperty.call(START_REASON_CODES, code)

/** The log text for a reason code, with the correlation id when there is one. Never carries material. */
export const startReasonLine = (code: StartReasonCode, reqId?: number | string): string =>
	reqId === undefined ? `[start] reason=${code}` : `[start] reason=${code} reqId=${String(reqId)}`
