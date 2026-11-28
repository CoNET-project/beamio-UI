// the total order of a message status.
import { higherStatus, isStatusDowngrade, messageStatusRank } from './messageStatusOrder'

describe('messageStatusOrder', () => {
	it('sending < failed = held statuses < sent < delivered < read; unknown and missing are below sending', () => {
		const order = ['sending', 'failed', 'sent', 'delivered', 'read']
		for (let i = 0; i < order.length - 1; i++) expect(messageStatusRank(order[i])).toBeLessThan(messageStatusRank(order[i + 1]))
		for (const held of ['route_unconfirmed', 'first_fetch_pending', 'fingerprint_changed']) {
			expect(messageStatusRank(held)).toBe(messageStatusRank('failed'))
			expect(messageStatusRank(held)).toBeGreaterThan(messageStatusRank('sending'))
			expect(messageStatusRank(held)).toBeLessThan(messageStatusRank('sent'))
		}
		for (const none of [undefined, null, '', 'nonsense', 7]) expect(messageStatusRank(none)).toBe(0)
	})
	it('a merge keeps the higher status; a tie keeps the first', () => {
		expect(higherStatus('sent', 'sending')).toBe('sent')
		expect(higherStatus('sending', 'delivered')).toBe('delivered')
		expect(higherStatus('failed', 'route_unconfirmed')).toBe('failed')
		expect(higherStatus('delivered', 'sent')).toBe('delivered')
	})
	it('what takes a message back is a downgrade', () => {
		expect(isStatusDowngrade('delivered', 'sent')).toBe(true)
		expect(isStatusDowngrade('sent', 'sending')).toBe(true)
		expect(isStatusDowngrade('sent', 'failed')).toBe(true) // a failed re-POST does not make an accepted message unsent
		expect(isStatusDowngrade('sending', 'sent')).toBe(false)
		expect(isStatusDowngrade('failed', 'sending')).toBe(true) // a retry's in-memory `sending` is not written over the stored failure; `sent` follows
		expect(isStatusDowngrade('failed', 'route_unconfirmed')).toBe(false)
	})
})
