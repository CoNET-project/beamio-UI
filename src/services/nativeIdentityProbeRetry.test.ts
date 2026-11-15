/**
 * The identity probe cadence and the identity capability store. A manual retry notifies the gate.
 */
import {
	getNativeIdentityCapability,
	identityProbeDelayMs,
	onNativeIdentityRetryRequested,
	requestNativeIdentityRetry,
	setNativeIdentityCapability,
	subscribeNativeIdentityCapability,
} from './nativeIdentityProbeRetry'

describe('the unanswered hello is probed again on a cadence', () => {
	it('10 s, then 30 s, then 60 s, and 60 s from then on', () => {
		expect([0, 1, 2, 3, 4, 9].map(identityProbeDelayMs)).toEqual([10_000, 30_000, 60_000, 60_000, 60_000, 60_000])
	})
})

describe('the identity capability store', () => {
	it('notifies subscribers only on a change, and not after unsubscribing', () => {
		setNativeIdentityCapability('unknown')
		const seen: string[] = []
		const off = subscribeNativeIdentityCapability(() => seen.push(getNativeIdentityCapability()))
		setNativeIdentityCapability('unanswered')
		setNativeIdentityCapability('unanswered')
		setNativeIdentityCapability('declared')
		off()
		setNativeIdentityCapability('missing')
		expect(seen).toEqual(['unanswered', 'declared'])
		expect(getNativeIdentityCapability()).toBe('missing')
		setNativeIdentityCapability('unknown')
	})
})

describe('a manual retry', () => {
	it('calls each listener that is still subscribed', () => {
		const first = jest.fn()
		const second = jest.fn()
		const offFirst = onNativeIdentityRetryRequested(first)
		const offSecond = onNativeIdentityRetryRequested(second)
		requestNativeIdentityRetry()
		offFirst()
		requestNativeIdentityRetry()
		offSecond()
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(2)
	})
})
