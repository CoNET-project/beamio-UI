/**
 * @jest-environment node
 */
/**
 * BCHAT 43: an untrusted route write never removes the stored verified fingerprint of a contact (no downgrade). A trusted write sets it.
 * SYNTHETIC values only.
 */
import { applyPeerRouteToRows, nextPeerChatData } from './peerRouteRecord'

const V = 'openpgp:aaaa'
const ADDR = '0x4444444444444444444444444444444444444444'

describe('untrusted writes keep the stored trust', () => {
	it('a route change written without trust keeps the stored verified fingerprint', () => {
		const before: { publicArmored: string; routersArmoreds: string; verifiedFingerprint?: string } = { publicArmored: 'OLD', routersArmoreds: 'R' }
		const next = nextPeerChatData(before, { publicArmored: 'NEW', routersArmoreds: 'R', fingerprint: 'bbbb' }, false)
		const rows: Array<{ address: string; chatData: { publicArmored: string; routersArmoreds: string; verifiedFingerprint?: string } }> = [{ address: ADDR, chatData: { publicArmored: 'OLD', routersArmoreds: 'R', verifiedFingerprint: V } }]
		const out = applyPeerRouteToRows(rows, ADDR, next, true)
		expect(out.rows[0].chatData?.verifiedFingerprint).toBe(V)
		expect(out.rows[0].chatData?.publicArmored).toBe('NEW')
	})

	it('a trusted write sets the verified fingerprint', () => {
		const next = nextPeerChatData({ publicArmored: 'OLD', routersArmoreds: 'R' }, { publicArmored: 'NEW', routersArmoreds: 'R', fingerprint: 'bbbb' }, true)
		const rows: Array<{ address: string; chatData: { publicArmored: string; routersArmoreds: string; verifiedFingerprint?: string } }> = [{ address: ADDR, chatData: { publicArmored: 'OLD', routersArmoreds: 'R' } }]
		const out = applyPeerRouteToRows(rows, ADDR, next, true)
		expect(out.rows[0].chatData?.verifiedFingerprint).toBe(next.verifiedFingerprint)
	})

	it('a trusted confirmation writes the stored trust even when the route did not move (force on trust)', () => {
		const next = nextPeerChatData({ publicArmored: 'SAME', routersArmoreds: 'R' }, { publicArmored: 'SAME', routersArmoreds: 'R', fingerprint: 'bbbb' }, true)
		const rows: Array<{ address: string; chatData: { publicArmored: string; routersArmoreds: string; verifiedFingerprint?: string } }> = [{ address: ADDR, chatData: { publicArmored: 'SAME', routersArmoreds: 'R' } }]
		const out = applyPeerRouteToRows(rows, ADDR, next, false || true)
		expect(out.changed).toBe(true)
		expect(out.rows[0].chatData?.verifiedFingerprint).toBe(next.verifiedFingerprint)
	})
})
