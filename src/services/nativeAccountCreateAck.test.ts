/**
 * / interface maintainers (3): the account-create open ack. `page`only on an ok ack (opened, none; any other value is
 * absent); `walletStatus` on a not_available ack (G0, G1, G2). SYNTHETIC payloads.
 */
import { parseAccountCreateOpenAck } from './nativeRecovery'

describe('parseAccountCreateOpenAck', () => {
	it('an ok ack with page "opened" reports the first screen is open', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: true, page: 'opened' })).toEqual({ ok: true, page: 'opened' })
	})

	it('an ok ack with page "none" reports no page was opened', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: true, page: 'none' })).toEqual({ ok: true, page: 'none' })
	})

	it('an ok ack with an unknown page value, or without the field, has no page', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: true, page: 'something_else' })).toEqual({ ok: true, page: undefined })
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: true })).toEqual({ ok: true, page: undefined })
	})

	it('a not_available ack carries walletStatus G0, G1 or G2; anything else is absent', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_available', walletStatus: 'G0' })).toEqual({ ok: false, reason: 'not_available', walletStatus: 'G0' })
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_available', walletStatus: 'G1' })).toEqual({ ok: false, reason: 'not_available', walletStatus: 'G1' })
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_available', walletStatus: 'G2' })).toEqual({ ok: false, reason: 'not_available', walletStatus: 'G2' })
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_available' })).toEqual({ ok: false, reason: 'not_available', walletStatus: undefined })
	})

	it('a failed ack never carries a page', () => {
		const r = parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'already_bound', page: 'opened' })
		expect(r).toEqual({ ok: false, reason: 'already_bound', walletStatus: undefined })
		expect('page' in r).toBe(false)
	})

	it('a missing or non-object payload is a bad ack', () => {
		expect(parseAccountCreateOpenAck(null)).toEqual({ ok: false, reason: 'bad_ack' })
		expect(parseAccountCreateOpenAck(undefined)).toEqual({ ok: false, reason: 'bad_ack' })
	})
})
