/**
 * The queued browser init (App.tsx) runs once after the one in flight. Its chat start is left to gossipStartDecision: with the
 * chat already active for the same account, the queued run skips the restart. SYNTHETIC values only.
 */
import { gossipStartDecision } from './historyClientBinding'

const EOA = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

describe('a queued init does not restart the chat for the same account', () => {
	it('chat active for the same account: skip (the queued run does not restart it)', () => {
		expect(gossipStartDecision({ gossip: true, bound: EOA, account: EOA, shell: false })).toBe('skip')
	})

	it('chat active, bound account not yet known: skip', () => {
		expect(gossipStartDecision({ gossip: true, bound: null, account: EOA, shell: false })).toBe('skip')
	})

	it('chat active for another account: restart (an account change is not skipped)', () => {
		expect(gossipStartDecision({ gossip: true, bound: OTHER, account: EOA, shell: false })).toBe('restart')
	})

	it('no chat yet: start', () => {
		expect(gossipStartDecision({ gossip: false, bound: null, account: EOA, shell: false })).toBe('start')
	})
})
