/**
 * The visible copy of a held, refused or unreadable recipient (⑤). Each copy is a locale key under `ui`in en.json and
 * zh-CN.json, so the owner can change the wording. The three lookup results stay apart: no record, a failed read, and a held key are
 * different copies (RPC global rule).
 */
import { tu } from '@/locale/beamioLocale'

/** The banner of a held chat send, by its held code. */
export function chatHeldBannerText(code: string): string {
	if (code === 'route_unconfirmed') return tu('chat.held.route_unconfirmed.banner')
	if (code === 'first_fetch_pending') return tu('chat.held.first_fetch_pending.banner')
	if (code === 'fingerprint_changed') return tu('chat.held.fingerprint_changed.banner')
	if (code === 'recipient_no_record') return tu('chat.held.no_record.banner')
	if (code === 'network_error') return tu('chat.held.network_error.banner')
	return tu('chat.held.unavailable.banner')
}

/**
 * The detail under a message that was not sent (the bubble). Only the codes that really are a held send or a failed recipient lookup use the held banners (including "the contact's key is
 * unavailable"); every other code is a plain failure with its own copy. before, any code that was not `send_failed` fell through to the held copy, so a message cut off by a
 * force kill (`interrupted`) said "the contact's key is unavailable" although the key was fine and the delivery was only unconfirmed.
 */
const HELD_BANNER_CODES: ReadonlySet<string> = new Set([
	'route_unconfirmed',
	'first_fetch_pending',
	'fingerprint_changed',
	'recipient_no_record',
	'network_error',
	'recipient_key_unavailable',
	'recipient_key_invalid',
])
export function sendFailedDetailText(code: string): string {
	if (code === 'unconfirmed') return tu('chat.failed.unconfirmed')
	if (code === 'interrupted') return tu('chat.failed.interrupted')
	if (code === 'persist_failed') return tu('chat.failed.persist_failed')
	if (code === 'identity_not_ready') return tu('chat.failed.identity_not_ready')
	if (HELD_BANNER_CODES.has(code)) return chatHeldBannerText(code)
	return tu('chat.failed.send_failed')
}

/** The label of a held message's status in the bubble. */
export function chatHeldLabelText(status: 'route_unconfirmed' | 'first_fetch_pending' | 'fingerprint_changed' | 'trusted_resend'): string {
	return tu(`chat.held.label.${status}`)
}

/** The copy of a payment receipt that was not sent (Pay, TopUp, payment request): the three results have their own copy. */
export function receiptNotSentText(code: string): string {
	if (code === 'recipient_no_record') return tu('chat.receipt.no_record')
	if (code === 'network_error' || code === 'route_unconfirmed') return tu('chat.receipt.network_error')
	if (code === 'first_fetch_pending' || code === 'fingerprint_changed') return tu('chat.receipt.held')
	return tu('chat.receipt.not_delivered')
}

/** The copy of a call that did not start (outgoing) or was not answered (incoming) because the contact's key is held or unreadable. */
export function callHeldText(direction: 'start' | 'answer'): string {
	return direction === 'start' ? tu('call.held.start') : tu('call.held.answer')
}

/** The copy of an account that could not be loaded after the capped reads. */
export function accountUnavailableText(reason: 'no_account' | 'network_error'): string {
	return reason === 'no_account' ? tu('account.unavailable.no_account') : tu('account.unavailable.network_error')
}
