import { callerDisplay, parseIncomingUnlockRequest, remainingAt, shouldSendShown } from './incomingUnlockRequest'

const EOA = '0x' + '11'.repeat(20)
const good = { callId: 'call-ABC_123', eoa: EOA, remainingMs: 10000, phase: 'load' }

describe('incoming unlock request parsing', () => {
	test('a complete request is accepted', () => {
		expect(parseIncomingUnlockRequest(good, EOA)).toEqual(good)
	})

	test.each([
		['missing remainingMs', { ...good, remainingMs: undefined }],
		['missing phase', { ...good, phase: undefined }],
		['remainingMs zero', { ...good, remainingMs: 0 }],
		['remainingMs negative', { ...good, remainingMs: -5 }],
		['remainingMs fractional', { ...good, remainingMs: 10.5 }],
		['remainingMs as string', { ...good, remainingMs: '10000' }],
		['phase unknown', { ...good, phase: 'done' }],
		['callId too short', { ...good, callId: 'short' }],
		['callId with a space', { ...good, callId: 'call id 12345' }],
		['eoa not lower-case', { ...good, eoa: '0x' + 'AB'.repeat(20) }],
		['eoa of another account', { ...good, eoa: '0x' + '22'.repeat(20) }],
	])('refused: %s', (_name, bad) => {
		expect(parseIncomingUnlockRequest(bad, EOA)).toBeNull()
	})

	test('a non-object payload is refused', () => {
		expect(parseIncomingUnlockRequest(null, EOA)).toBeNull()
		expect(parseIncomingUnlockRequest('x', EOA)).toBeNull()
	})
})

describe('countdown', () => {
	test('the countdown starts from remainingMs, not the full amount, and runs down with time', () => {
		const req = { remainingMs: 7000 }
		expect(remainingAt(req, 1000, 1000)).toBe(7000)
		expect(remainingAt(req, 1000, 4000)).toBe(4000)
		expect(remainingAt(req, 1000, 9000)).toBe(0)
	})

	test('never more than remainingMs, never negative', () => {
		expect(remainingAt({ remainingMs: 5 }, 100, 50)).toBe(5)
		expect(remainingAt({ remainingMs: 5 }, 100, 1_000_000)).toBe(0)
	})
})

describe('the Shown rule', () => {
	test('phase load sends Shown once', () => {
		expect(shouldSendShown({ phase: 'load' }, false)).toBe(true)
		expect(shouldSendShown({ phase: 'load' }, true)).toBe(false)
	})

	test('phase input never sends Shown', () => {
		expect(shouldSendShown({ phase: 'input' }, false)).toBe(false)
	})
})

describe('caller display', () => {
	const FROM = '0xABCDEF0000000000000000000000000000000001'

	test('the identity is the verified from, shown as a short address; no name is ever looked up', () => {
		const d = callerDisplay({ verifiedFrom: FROM })
		expect(d.address).toBe(FROM.toLowerCase())
		expect(d.shortAddress).toBe('0xabcd…0001')
		expect(d.name).toBeNull()
	})

	test('a peer tag is only a secondary text marked unverified and never replaces the address', () => {
		const d = callerDisplay({ verifiedFrom: FROM, peerTag: 'bob' })
		expect(d.tag).toBe('bob')
		expect(d.tagVerified).toBe(false)
		expect(d.address).toBe(FROM.toLowerCase())
	})

	test('no tag leaves the tag empty', () => {
		expect(callerDisplay({ verifiedFrom: FROM }).tag).toBeNull()
	})

	test('a contact name is not part of the display: no name parameter exists and the name stays null', () => {
		const d = callerDisplay({ verifiedFrom: FROM, peerTag: '  ' })
		expect(d.name).toBeNull()
		expect(d.tag).toBeNull()
	})
})
