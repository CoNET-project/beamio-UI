/**
 * @jest-environment node
 */
// a first pinned value from a non-text path reaches the stored record AND the page's profile state, and a later write from that state keeps it.
import { applyPeerRouteToRows, applyPinnedToProfiles, nextPeerChatData, FIRST_PIN_APPLIED_EVENT } from './peerRouteRecord'
import { readStoredKeyFingerprint } from '../utils/pgpFingerprint'

const CONTACT = '0x' + 'ab12'.repeat(10)
const OTHER = '0x' + '33'.repeat(20)
const FP = '0123456789abcdef0123456789abcdef01234567'
const pinned = { publicArmored: 'ARMOR', routersArmoreds: 'ROUTE', routePgpKeyID: 'r1', fingerprint: FP }
const profiles = (chats: unknown[]) => [{ keyID: CONTACT, chats }] as Array<{ keyID: string; chats: Array<{ address: string; chatData?: Record<string, unknown> }> }>

describe('applyPinnedToProfiles (the page state copy)', () => {
	it('writes the first pinned value into the contact row and leaves the other rows alone', () => {
		const before = profiles([{ address: CONTACT, chatData: { publicArmored: '' } }, { address: OTHER, chatData: {} }])
		const after = applyPinnedToProfiles(before, CONTACT, pinned)!
		expect(after).not.toBe(before)
		expect(readStoredKeyFingerprint(after[0].chats[0].chatData?.verifiedFingerprint as string)).toBe(FP)
		expect(after[0].chats[1]).toBe(before[0].chats[1])
	})
	it('no row, a verified row, or no profiles: unchanged (the same array)', () => {
		const a = profiles([{ address: OTHER, chatData: {} }])
		expect(applyPinnedToProfiles(a, CONTACT, pinned)).toBe(a)
		const v = profiles([{ address: CONTACT, chatData: { verifiedFingerprint: `openpgp:${'e'.repeat(40)}` } }])
		expect(applyPinnedToProfiles(v, CONTACT, pinned)).toBe(v)
		expect(applyPinnedToProfiles(null, CONTACT, pinned)).toBeNull()
		expect(applyPinnedToProfiles([], CONTACT, pinned)).toEqual([])
	})
	it('pay or call first, then a refresh: the state copy was updated, so a later untrusted route write from that state keeps the pin', () => {
		const state = applyPinnedToProfiles(profiles([{ address: CONTACT, chatData: { publicArmored: '' } }]), CONTACT, pinned)!
		// the page's periodic refresh writes the route (untrusted): it must carry no downgrade
		const route = nextPeerChatData(state[0].chats[0].chatData as never, { publicArmored: 'ARMOR2', routersArmoreds: 'ROUTE2', fingerprint: FP }, false)
		const { rows } = applyPeerRouteToRows(state[0].chats as never[], CONTACT, route, true)
		expect(readStoredKeyFingerprint((rows[0] as { chatData: { verifiedFingerprint: string } }).chatData.verifiedFingerprint)).toBe(FP)
	})
	it('WITHOUT the state sync the stale state has no pin (what the review feared), so the sync is what keeps it', () => {
		const stale = profiles([{ address: CONTACT, chatData: { publicArmored: '' } }])
		expect((stale[0].chats[0].chatData as { verifiedFingerprint?: string }).verifiedFingerprint).toBeUndefined()
	})
	it('the event name is the one the provider listens for', () => {
		expect(FIRST_PIN_APPLIED_EVENT).toBe('beamio:first-pin-applied')
	})
})
