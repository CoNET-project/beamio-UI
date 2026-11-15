/**
 * (items 2 and 3): the timing of the entry gate's no-key decision, through the controller the gate uses.
 * Covers the ok answer that arrives before the ready event and before the native read, and the late no_key after it.
 * Each case starts from a shell whose hello answer declared native keys (G1), so only the rules decide the outcome.
 */
import { AppEntryNoKeyController } from './appEntryNoKeyController'

describe('entry gate no-key controller: timing', () => {
	it('control: decided with an empty store and no wallet, then no_key: the import route shows', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.storageRead(true)
		expect(c.onNativeNoKey()).toBe(true)
	})

	it('residual: no_key while a native create or recovery page is open does not cover it; after it closes it does', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.storageRead(true)
		c.beginNativeFlow()
		expect(c.onNativeNoKey()).toBe(false)
		c.endNativeFlow()
		expect(c.onNativeNoKey()).toBe(true)
	})

	it('residual: the ok answer ends the open native flow, so a later no_key is a no-op because a wallet exists', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.storageRead(true)
		c.beginNativeFlow()
		c.established()
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('no_key before the gate decides never shows the import route', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		expect(c.onNativeNoKey()).toBe(false)
		c.storageRead(true)
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('creation ok, then a late no_key before the ready event and before the native read: no takeover', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.storageRead(true) // onboarding with an empty store
		c.established() // the ok answer: synchronous, before reachNativeWallet and before the ready event
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('already_exists answers the same way: a late no_key does not take over', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.storageRead(true)
		c.established()
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('a restore ok, then no_key before the store read finishes: no takeover', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.established()
		c.decide()
		expect(c.onNativeNoKey()).toBe(false)
		c.storageRead(true) // a later read of an empty store must not re-open the route
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('storage unavailable (never confirmed empty): no_key never overrides it', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('a page account at the startup read: no_key never takes over', () => {
		const c = new AppEntryNoKeyController()
		c.capabilityResolved(true)
		c.decide()
		c.established() // the startup read found an account
		expect(c.onNativeNoKey()).toBe(false)
	})
})

/**
 * G1: the shell capability gates the import route. Three orders are covered: no_key first, hello first, and a hello
 * that timed out (the gate receives a non-native state). A shell that declared no native keys never takes over.
 */
describe('entry gate no-key controller: shell capability (G1)', () => {
	const ready = () => {
		const c = new AppEntryNoKeyController()
		c.decide()
		c.storageRead(true)
		return c
	}

	it('order 1, no_key first: held back while unknown; the native hello then shows the import route once', () => {
		const c = ready()
		expect(c.onNativeNoKey()).toBe(false)
		expect(c.capabilityResolved(true)).toBe(true)
		expect(c.capabilityResolved(true)).toBe(false) // a second answer does not show it again
	})

	it('order 2, hello first: the native hello then no_key shows the import route at once', () => {
		const c = ready()
		expect(c.capabilityResolved(true)).toBe(false) // nothing held back
		expect(c.onNativeNoKey()).toBe(true)
	})

	it('order 3, hello timed out (non-native state): the held no_key never shows the import route', () => {
		const c = ready()
		expect(c.onNativeNoKey()).toBe(false)
		expect(c.capabilityResolved(false)).toBe(false)
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('order 3b, no_key arrives after a timed-out hello: no takeover', () => {
		const c = ready()
		expect(c.capabilityResolved(false)).toBe(false)
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('a shell without native keys (answered, no capability): no_key never shows the import route', () => {
		const c = ready()
		c.capabilityResolved(false)
		expect(c.onNativeNoKey()).toBe(false)
	})

	it('native hello, but the gate has not decided: the held no_key does not take over (existing rule)', () => {
		const c = new AppEntryNoKeyController()
		c.storageRead(true)
		expect(c.onNativeNoKey()).toBe(false)
		expect(c.capabilityResolved(true)).toBe(false)
	})

	it('no_key before the gate decides is not held: a later decide and a native hello do not show it', () => {
		const c = new AppEntryNoKeyController()
		c.storageRead(true)
		expect(c.onNativeNoKey()).toBe(false)
		c.decide()
		c.storageRead(true)
		expect(c.capabilityResolved(true)).toBe(false)
	})

	it('no_key after the gate decides, while the capability is unknown, is held and shows after a native hello', () => {
		const c = new AppEntryNoKeyController()
		c.decide()
		c.storageRead(true)
		expect(c.onNativeNoKey()).toBe(false)
		expect(c.capabilityResolved(true)).toBe(true)
	})

	it('native hello, then a wallet is established before the no_key: no takeover', () => {
		const c = ready()
		expect(c.onNativeNoKey()).toBe(false)
		c.established()
		expect(c.capabilityResolved(true)).toBe(false)
	})
})
