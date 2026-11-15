/**
 *: the binding of a worker client to an account. A client bound to another account, or to none, feeds nothing.
 * SYNTHETIC values only.
 */
import { canReadForAccount, shouldApplyBufferBatch, gossipStartDecision, inboundLineForAccount, listenParamsFitAccount, accountChangeAction } from './historyClientBinding'

const X = '0x1111111111111111111111111111111111111111'
const Y = '0x2222222222222222222222222222222222222222'

describe('a client feeds only its own account', () => {
	it('the same account, in any letter case, may be read', () => {
		expect(canReadForAccount(X, X)).toBe(true)
		expect(canReadForAccount(X.toUpperCase().replace('0X', '0x'), X)).toBe(true)
	})

	it('another account is refused: an old client never feeds a new account', () => {
		expect(canReadForAccount(X, Y)).toBe(false)
	})

	it('no client (null) or no account (empty) is refused', () => {
		expect(canReadForAccount(null, X)).toBe(false)
		expect(canReadForAccount(undefined, X)).toBe(false)
		expect(canReadForAccount(X, '')).toBe(false)
	})

	it('a buffer batch is applied only for the bound account', () => {
		expect(shouldApplyBufferBatch(X, X)).toBe(true)
		expect(shouldApplyBufferBatch(X, Y)).toBe(false)
		expect(shouldApplyBufferBatch(null, X)).toBe(false)
	})
})

describe('whether a gossip start restarts the live client', () => {
	const base = { bound: X, account: X, shell: false }
	it('no live gossip: start', () => {
		expect(gossipStartDecision({ ...base, gossip: false })).toBe('start')
	})
	it('a live client bound to the current account: skip, as before', () => {
		expect(gossipStartDecision({ ...base, gossip: true })).toBe('skip')
	})
	it('a live client bound to ANOTHER account: restart (the old client is stopped, the new account gets its own)', () => {
		expect(gossipStartDecision({ ...base, gossip: true, account: Y })).toBe('restart')
	})
	it('the account is not known yet, or no client is bound yet (one being created): skip', () => {
		expect(gossipStartDecision({ ...base, gossip: true, account: '' })).toBe('skip')
		expect(gossipStartDecision({ ...base, gossip: true, bound: null })).toBe('skip')
	})
	it('a shell owns its listen: skip, even for another account (the native layer answers address_mismatch)', () => {
		expect(gossipStartDecision({ ...base, gossip: true, account: Y, shell: true })).toBe('skip')
	})
	it('the comparison ignores letter case', () => {
		expect(gossipStartDecision({ ...base, gossip: true, bound: X, account: X.toUpperCase().replace('0X', '0x') })).toBe('skip')
	})
})

describe('an inbound line belongs to the account whose client decrypted it', () => {
	it('a line from the client of the current account is passed on', () => {
		expect(inboundLineForAccount(X, X)).toBe(true)
	})
	it('a line from a client of another account is not passed on (not stored, not acknowledged)', () => {
		expect(inboundLineForAccount(X, Y)).toBe(false)
	})
	it('no client bound (null) is not passed on while an account is current', () => {
		expect(inboundLineForAccount(null, X)).toBe(false)
	})
	it('before the page knows any account (no page mounted), the lines are passed on as before', () => {
		expect(inboundLineForAccount(X, null)).toBe(true)
	})
	it('an empty current account (no profile yet) passes nothing', () => {
		expect(inboundLineForAccount(X, '')).toBe(false)
	})
})

describe('the voice route restart does not reuse the parameters of another account', () => {
	it('the parameters of the same account are reused, in any letter case', () => {
		expect(listenParamsFitAccount(X, X)).toBe(true)
		expect(listenParamsFitAccount(X, X.toUpperCase().replace('0X', '0x'))).toBe(true)
	})
	it('the parameters of another account are not reused', () => {
		expect(listenParamsFitAccount(X, Y)).toBe(false)
	})
	it('an unknown current account, or no recorded listen account, keeps the old behaviour (reuse)', () => {
		expect(listenParamsFitAccount(X, '')).toBe(true)
		expect(listenParamsFitAccount(undefined, Y)).toBe(true)
		expect(listenParamsFitAccount(null, Y)).toBe(true)
	})
})

describe('an account change restarts a live client of the old account', () => {
	const change = (over: Partial<Parameters<typeof accountChangeAction>[0]> = {}) =>
		accountChangeAction({ previousAccount: X, account: Y, gossip: true, bound: X, shell: false, ...over })
	it('a session change (X to Y) with a live client of X restarts it', () => {
		expect(change()).toBe('restart')
	})
	it('a mount, or the first account (no previous account), is not a change', () => {
		expect(change({ previousAccount: '' , bound: X, account: X })).toBe('none')
	})
	it('the same account again is not a change', () => {
		expect(change({ previousAccount: X, account: X })).toBe('none')
	})
	it('no live gossip: nothing to restart', () => {
		expect(change({ gossip: false })).toBe('none')
	})
	it('the live client already belongs to the new account: nothing to restart', () => {
		expect(change({ bound: Y })).toBe('none')
	})
	it('a shell owns its listen: nothing to restart here', () => {
		expect(change({ shell: true })).toBe('none')
	})
	it('the account going empty is not a restart', () => {
		expect(change({ account: '' })).toBe('none')
	})
})
