/**
 * @jest-environment node
 */
/**
 * BCHAT 36: a trust write must be persisted even when the copy and the stored row share the chatData object.
 * The helpers never change the object they are given; a write is compared with the object before it.
 */
import { applyPeerRouteToRows, nextPeerChatData, routeFieldsDiffer, type PeerRouteFields } from './peerRouteRecord'
import { storedKeyFingerprint } from '../utils/pgpFingerprint'

const ADDRESS = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'
const FP = 'a'.repeat(40)
const incoming = { publicArmored: 'KEY-A', routersArmoreds: 'ROUTE-1', routePgpKeyID: 'R1', fingerprint: FP }

const baseRow = (): { address: string; chatData: PeerRouteFields } => ({
	address: ADDRESS,
	chatData: { publicArmored: '', routersArmoreds: '', online: false, routePgpKeyID: '' },
})

describe('nextPeerChatData', () => {
	it('does not change the object it is given', () => {
		const before = baseRow().chatData
		nextPeerChatData(before, incoming, true)
		expect(before.verifiedFingerprint).toBeUndefined()
		expect(before.keyFingerprint).toBeUndefined()
		expect(before.publicArmored).toBe('')
	})

	it('a trusted write sets the verified fingerprint in the OpenPGP scheme', () => {
		const next = nextPeerChatData(baseRow().chatData, incoming, true)
		expect(next.verifiedFingerprint).toBe(storedKeyFingerprint(FP))
		expect(next.keyFingerprint).toBe(storedKeyFingerprint(FP))
		expect(next.publicArmored).toBe('KEY-A')
	})

	it('an untrusted write (a route refresh) never sets the verified fingerprint', () => {
		const next = nextPeerChatData(baseRow().chatData, incoming, false)
		expect(next.verifiedFingerprint).toBeUndefined()
		expect(next.keyFingerprint).toBe(storedKeyFingerprint(FP))
	})

	it('keeps the fields that the write does not change', () => {
		const before: PeerRouteFields = { publicArmored: 'OLD', routersArmoreds: 'OLD-R', online: true, nativeWakeable: true, routePgpKeyID: 'X' }
		const next = nextPeerChatData(before, { publicArmored: 'NEW', routersArmoreds: 'NEW-R' }, false)
		expect(next).toMatchObject({ online: true, nativeWakeable: true, routePgpKeyID: 'X', publicArmored: 'NEW' })
	})
})

describe('applyPeerRouteToRows: the copy and the stored row share the chatData object', () => {
	it('a trust write on a shared object is detected and persisted into the stored row', () => {
		const row = baseRow()
		const copy = { ...row } // the chat page holds a shallow copy: copy.chatData === row.chatData
		expect(copy.chatData).toBe(row.chatData)
		const next = nextPeerChatData(copy.chatData, incoming, true)
		const moved = routeFieldsDiffer(copy.chatData, next)
		expect(moved).toBe(true)
		copy.chatData = next as typeof copy.chatData
		const { rows, changed } = applyPeerRouteToRows([row], ADDRESS, next, moved)
		expect(changed).toBe(true)
		expect(rows[0].chatData?.verifiedFingerprint).toBe(storedKeyFingerprint(FP))
	})

	it('survives a JSON round trip (a reload reads the stored copy)', () => {
		const row = baseRow()
		const copy = { ...row }
		const next = nextPeerChatData(copy.chatData, incoming, true)
		const { rows } = applyPeerRouteToRows([row], ADDRESS, next, routeFieldsDiffer(copy.chatData, next))
		const reloaded = JSON.parse(JSON.stringify(rows))
		expect(reloaded[0].chatData.verifiedFingerprint).toBe(storedKeyFingerprint(FP))
	})

	it('an identical write changes nothing and returns the same array', () => {
		const row = { address: ADDRESS, chatData: nextPeerChatData(null, incoming, true) }
		const rows = [row]
		const again = nextPeerChatData(row.chatData, incoming, true)
		const { rows: out, changed } = applyPeerRouteToRows(rows, ADDRESS, again, routeFieldsDiffer(row.chatData, again))
		expect(changed).toBe(false)
		expect(out).toBe(rows)
	})

	it('a stored row whose key is older than the write is updated even when the copy already moved', () => {
		const stored = { address: ADDRESS, chatData: { publicArmored: 'OLD', routersArmoreds: 'R', online: false, routePgpKeyID: '' } as PeerRouteFields }
		const next = nextPeerChatData(stored.chatData, incoming, false)
		const { rows, changed } = applyPeerRouteToRows([stored], ADDRESS, next, false)
		expect(changed).toBe(true)
		expect(rows[0].chatData?.publicArmored).toBe('KEY-A')
	})

	it('rows of other contacts are not touched', () => {
		const mine = baseRow()
		const other = { address: OTHER, chatData: { publicArmored: 'OTHER', routersArmoreds: 'R', online: false, routePgpKeyID: '' } as PeerRouteFields }
		const next = nextPeerChatData(mine.chatData, incoming, true)
		const { rows } = applyPeerRouteToRows([mine, other], ADDRESS, next, true)
		expect(rows[1]).toBe(other)
		expect(rows[1].chatData?.publicArmored).toBe('OTHER')
	})
})
