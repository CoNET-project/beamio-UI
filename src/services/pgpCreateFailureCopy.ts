/**
 * What the page says when a create-chat-identity action does not end well (0.53.52). One reason, one copy: "Can't read your Chat identity right now"
 * (chat.restore_retry.body) is only for a real read failure, not for a create that was never sent.
 *
 * - not_enabled, not_eligible, no_account: the page already knows before any click, so the button is not shown and there is no failure line (null).
 * - native_unavailable: the shell's chat identity module cannot be reached.
 * - timeout: the create did not finish in time; nothing was changed.
 * - locked: the wallet is locked.
 * - read_failed, not_ready: a real read failure (the existing copy).
 * - any other native refusal code: the action is not available now.
 * - no reason at all (a browser regenerate that failed without one): a generic "could not create".
 */
export type PgpCreateFailureCopy = { key: string } | null

const NO_FAILURE_LINE = new Set(['not_enabled', 'not_eligible', 'no_account'])

export function pgpCreateFailureCopyKey(reason: string | null | undefined): string | null {
	if (reason === undefined || reason === null || reason === '') return 'chat.create_retry.body'
	if (NO_FAILURE_LINE.has(reason)) return null
	if (reason === 'native_unavailable') return 'chat.create_unavailable.body'
	if (reason === 'timeout') return 'chat.create_timeout.body'
	if (reason === 'locked') return 'chat.create_locked.body'
	if (reason === 'read_failed' || reason === 'not_ready') return 'chat.restore_retry.body'
	return 'chat.create_refused.body'
}

/** true when the page can already tell that the click would not send anything (so the button is not shown). */
export function createNeverSends(reason: string | null | undefined): boolean {
	return reason !== undefined && reason !== null && NO_FAILURE_LINE.has(reason)
}
