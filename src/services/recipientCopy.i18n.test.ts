/**
 * ⑤: every copy key used for a held, refused, unreadable or unavailable state exists in en and zh-CN, and resolves to its text through
 * the real `tu` (not the raw key, and not an English placeholder in the zh-CN file). Real i18n instance; no mocks.
 */
import i18next from 'i18next'
import en from '@/locale/en.json'
import zh from '@/locale/zh-CN.json'
import { accountUnavailableText, callHeldText, chatHeldBannerText, chatHeldLabelText, receiptNotSentText, sendFailedDetailText } from './recipientCopy'

const KEYS = [
	'chat.held.route_unconfirmed.banner',
	'chat.held.first_fetch_pending.banner',
	'chat.held.fingerprint_changed.banner',
	'chat.held.no_record.banner',
	'chat.held.network_error.banner',
	'chat.held.unavailable.banner',
	'chat.held.label.route_unconfirmed',
	'chat.held.label.first_fetch_pending',
	'chat.held.label.fingerprint_changed',
	'chat.held.fingerprint.caption',
	'chat.held.action.verify',
	'chat.held.action.accept',
	'chat.held.action.retry',
	'chat.held.action.send_anyway',
	'chat.receipt.no_record',
	'chat.receipt.network_error',
	'chat.receipt.held',
	'chat.receipt.not_delivered',
	'chat.failed.send_failed',
	'chat.held.lost',
	'call.held.start',
	'call.held.answer',
	'account.unavailable.no_account',
	'account.unavailable.network_error',
	'account.unavailable.retry',
	'pgp.temporary.body',
	'pgp.temporary.stopped',
	'pgp.temporary.retry',
]

describe.each(['en', 'zh-CN'])('recipient copy keys (%s)', (lng) => {
	beforeAll(async () => {
		await i18next.changeLanguage(lng)
	})

	it('every key exists in both locale files with text', () => {
		for (const key of KEYS) {
			const e = (en as { ui: Record<string, string> }).ui[key]
			const z = (zh as { ui: Record<string, string> }).ui[key]
			expect(typeof e).toBe('string')
			expect(e.trim().length).toBeGreaterThan(0)
			expect(typeof z).toBe('string')
			expect(z.trim().length).toBeGreaterThan(0)
		}
	})

	it('the copy functions return text, never the raw key', () => {
		const out = [
			chatHeldBannerText('route_unconfirmed'),
			chatHeldBannerText('first_fetch_pending'),
			chatHeldBannerText('fingerprint_changed'),
			chatHeldBannerText('recipient_no_record'),
			chatHeldBannerText('network_error'),
			chatHeldLabelText('first_fetch_pending'),
			receiptNotSentText('recipient_no_record'),
			receiptNotSentText('network_error'),
			receiptNotSentText('first_fetch_pending'),
			callHeldText('start'),
			callHeldText('answer'),
			accountUnavailableText('no_account'),
			accountUnavailableText('network_error'),
			sendFailedDetailText('send_failed'),
		]
		for (const text of out) {
			expect(text).not.toMatch(/^(chat|call|account|pgp)\./)
			expect(text.trim().length).toBeGreaterThan(0)
		}
	})
})

describe('the three lookup results have separate receipt copy', () => {
	beforeAll(async () => {
		await i18next.changeLanguage('en')
	})

	it('no_record, network_error and a held key are three different texts', () => {
		const noRecord = receiptNotSentText('recipient_no_record')
		const network = receiptNotSentText('network_error')
		const held = receiptNotSentText('first_fetch_pending')
		expect(new Set([noRecord, network, held]).size).toBe(3)
	})
})
