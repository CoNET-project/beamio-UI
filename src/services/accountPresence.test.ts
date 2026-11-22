/**
 * presence mapping, TS-01 to TS-06 (vectors in pgp-migration-vectors.v2.json, sha256 3ced6796…e613).
 * The table below carries each vector's input and expected result.
 */
import { nativePresence, onboardingAllowed, type NativePresenceInput } from './accountPresence'

const cases: Array<{ id: string; input: NativePresenceInput; expect: string }> = [
	{ id: 'TS-01', input: { ws: 'no_key', kPresent: false, snapshotUnknown: false }, expect: 'confirmed_none' },
	{ id: 'TS-02', input: { ws: 'not_ready', reason: 'g1_uninitialized', snapshotUnknown: false }, expect: 'has' },
	{ id: 'TS-03', input: { ws: 'unlocked', snapshotUnknown: false }, expect: 'has' },
	{ id: 'TS-04', input: { ws: 'not_ready', reason: 'unreadable', snapshotUnknown: false }, expect: 'unknown' },
	{ id: 'TS-05', input: { ws: 'not_ready', reason: 'unreadable', snapshotUnknown: true }, expect: 'unknown' },
	{ id: 'TS-06', input: { ws: 'no_key', kPresent: true, snapshotUnknown: false }, expect: 'unknown' }, // PNK-04 supersedes the earlier case here
]

describe('native presence', () => {
	for (const c of cases) {
		it(`${c.id}: ${c.expect}`, () => {
			expect(nativePresence(c.input)).toBe(c.expect)
		})
	}

	it('locked is unknown, not has: a locked wallet does not prove the account on this page', () => {
		expect(nativePresence({ ws: 'locked', snapshotUnknown: false })).toBe('unknown')
	})

	it('key_only is confirmed none (C5 / Q3); an unknown reason is unknown; phrase_only with an eoa is has', () => {
		expect(nativePresence({ ws: 'not_ready', reason: 'key_only', snapshotUnknown: false })).toBe('confirmed_none')
		expect(nativePresence({ ws: 'not_ready', reason: 'unreadable', snapshotUnknown: false })).toBe('unknown')
		expect(nativePresence({ ws: 'phrase_only', snapshotUnknown: false })).toBe('has')
	})

	it('no_key with kPresent false is confirmed none; kPresent true is never none', () => {
		expect(nativePresence({ ws: 'no_key', kPresent: false, snapshotUnknown: false })).toBe('confirmed_none')
		expect(nativePresence({ ws: 'no_key', kPresent: true, snapshotUnknown: false })).toBe('unknown')
	})

	it('no_key with kPresent missing or not a boolean is a read error: unknown', () => {
		expect(nativePresence({ ws: 'no_key', snapshotUnknown: false })).toBe('unknown')
		expect(nativePresence({ ws: 'no_key', kPresent: 'yes' as unknown as boolean, snapshotUnknown: false })).toBe('unknown')
	})

	it('a failed native read (not_ready, unreadable, unknown snapshot) is unknown, never onboarding', () => {
		expect(nativePresence({ ws: 'not_ready', reason: 'unreadable', snapshotUnknown: false })).toBe('unknown')
		expect(nativePresence({ ws: 'no_key', kPresent: true, snapshotUnknown: true })).toBe('unknown')
	})

	it('not_ready without a reason is unknown', () => {
		expect(nativePresence({ ws: 'not_ready', snapshotUnknown: false })).toBe('unknown')
	})

	it('onboarding only when both sides are confirmed_none', () => {
		expect(onboardingAllowed('confirmed_none', 'confirmed_none')).toBe(true)
		expect(onboardingAllowed('confirmed_none', 'unknown')).toBe(false)
		expect(onboardingAllowed('unknown', 'confirmed_none')).toBe(false)
		expect(onboardingAllowed('has', 'confirmed_none')).toBe(false)
	})
})
