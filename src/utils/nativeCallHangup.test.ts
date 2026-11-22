import { handleNativeCallHangup, parseNativeCallHangup, type ConnectedCall } from './nativeCallHangup'

const hangup = (over: Record<string, unknown> = {}) => ({
	type: 'nativeCallHangup', callId: 'c-1', sessionId: 's-1', reason: 'local_hangup', at: 1700000000, ...over,
})

function run(current: ConnectedCall, payload: unknown) {
	const ends: string[] = []
	const out = handleNativeCallHangup(payload, {
		getCurrent: () => current,
		endCall: (c, s) => ends.push(`${c}|${s}`),
	})
	return { out, ends }
}

describe('nativeCallHangup', () => {
	test('a matching hangup on the connected call ends it once', () => {
		const { out, ends } = run({ callId: 'c-1', sessionId: 's-1', connected: true }, hangup())
		expect(out).toBe('ended')
		expect(ends).toEqual(['c-1|s-1'])
	})
	test('a wrong callId is a no-op', () => {
		const { out, ends } = run({ callId: 'c-1', sessionId: 's-1', connected: true }, hangup({ callId: 'c-2' }))
		expect(out).toBe('noop')
		expect(ends).toEqual([])
	})
	test('a wrong sessionId is a no-op', () => {
		const { out, ends } = run({ callId: 'c-1', sessionId: 's-1', connected: true }, hangup({ sessionId: 's-2' }))
		expect(out).toBe('noop')
		expect(ends).toEqual([])
	})
	test('a duplicate event after the call ended is a no-op', () => {
		const first = run({ callId: 'c-1', sessionId: 's-1', connected: true }, hangup())
		expect(first.out).toBe('ended')
		const second = run(null, hangup())
		expect(second.out).toBe('noop')
		expect(second.ends).toEqual([])
	})
	test('no connected call (ringing or dialing) is a no-op', () => {
		const { out, ends } = run({ callId: 'c-1', sessionId: 's-1', connected: false }, hangup())
		expect(out).toBe('noop')
		expect(ends).toEqual([])
	})
	test('at does not take part in the check', () => {
		const { out } = run({ callId: 'c-1', sessionId: 's-1', connected: true }, hangup({ at: 'anything' }))
		expect(out).toBe('ended')
	})
	test('a payload with another reason or a missing handle is refused', () => {
		expect(parseNativeCallHangup(hangup({ reason: 'remote' }))).toBeNull()
		expect(parseNativeCallHangup(hangup({ callId: '' }))).toBeNull()
		expect(parseNativeCallHangup(hangup({ sessionId: undefined }))).toBeNull()
		expect(parseNativeCallHangup({ type: 'something_else' })).toBeNull()
		expect(parseNativeCallHangup(null)).toBeNull()
	})
})

import {
	clearConnectedCallIfMatches,
	getConnectedCall,
	handleRegisteredNativeCallHangup,
	installNativeCallHangupWatcher,
	setConnectedCall,
} from './nativeCallHangup'

describe('registered call and the App-level watcher (chat page not mounted)', () => {
	afterEach(() => setConnectedCall(null))

	test('a registered connected call is ended once by a matching hang-up, with the chat page absent', () => {
		let endCount = 0
		setConnectedCall({ callId: 'c-9', sessionId: 's-9', end: () => { endCount += 1 } })
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-9', sessionId: 's-9' }))).toBe('ended')
		expect(endCount).toBe(1)
		// duplicate event: no second end
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-9', sessionId: 's-9' }))).toBe('noop')
		expect(endCount).toBe(1)
		expect(getConnectedCall()).toBeNull()
	})
	test('the page own end clears the registration, so a later native event does nothing', () => {
		let endCount = 0
		setConnectedCall({ callId: 'c-8', sessionId: 's-8', end: () => { endCount += 1 } })
		clearConnectedCallIfMatches('c-8', 's-8')
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-8', sessionId: 's-8' }))).toBe('noop')
		expect(endCount).toBe(0)
	})
	test('a wrong handle does not end the registered call', () => {
		let endCount = 0
		setConnectedCall({ callId: 'c-7', sessionId: 's-7', end: () => { endCount += 1 } })
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-7', sessionId: 'other' }))).toBe('noop')
		expect(endCount).toBe(0)
	})
	test('the watcher delivers chatModuleEvent inner events only, and ignores other events', () => {
		const got: unknown[] = []
		const remove = installNativeCallHangupWatcher((p) => got.push(p))
		window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: hangup() } }))
		window.dispatchEvent(new CustomEvent('cashtreesandroid', { detail: { action: 'somethingElse', event: hangup() } }))
		expect(got.length).toBe(1)
		remove?.()
		window.dispatchEvent(new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: hangup() } }))
		expect(got.length).toBe(1)
	})
})

describe('registration ends with the connected call (peer ended first)', () => {
	afterEach(() => setConnectedCall(null))
	test('after the peer ended the call, a same-handle native hang-up is a no-op and ends nothing', () => {
		let endCount = 0
		setConnectedCall({ callId: 'c-6', sessionId: 's-6', end: () => { endCount += 1 } })
		// the peer's voice_end_v1 (App) or the page's answered-off effect clears the registration
		clearConnectedCallIfMatches('c-6', 's-6')
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-6', sessionId: 's-6' }))).toBe('noop')
		expect(endCount).toBe(0)
	})
	test('clearing another call does not clear the registered one', () => {
		let endCount = 0
		setConnectedCall({ callId: 'c-5', sessionId: 's-5', end: () => { endCount += 1 } })
		clearConnectedCallIfMatches('c-x', 's-x')
		expect(handleRegisteredNativeCallHangup(hangup({ callId: 'c-5', sessionId: 's-5' }))).toBe('ended')
		expect(endCount).toBe(1)
	})
})
