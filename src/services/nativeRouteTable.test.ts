/**
 * @jest-environment node
 */
/** The contact route table handed to the native module (delivered receipts). SYNTHETIC addresses and armor. */
import { createRouteTable, routeEligibility, readKeyOfDecision, applyRouteEligibility, ROUTE_TABLE_MAX_ENTRIES, ROUTE_ARMOR_MAX_BYTES, ROUTE_SYNC_DEBOUNCE_MS, ROUTE_SYNC_RETRY_MS, type RouteEntry } from './nativeRouteTable'
import { markMessageDeliveredBySendId } from '../utils/chatDeliveryReceipt'

const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC\n-----END PGP PUBLIC KEY BLOCK-----'
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')

function harness(ready = true) {
	const sent: RouteEntry[][] = []
	const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
	let isReady = ready
	const table = createRouteTable({
		send: (routes) => {
			if (!isReady) return false
			sent.push(routes)
			return true
		},
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true }
			timers.push(t)
			return t
		},
		clearTimer: (t) => {
			;(t as { live: boolean }).live = false
		},
	})
	const fire = () => {
		const t = timers.find((x) => x.live)
		if (t) {
			t.live = false
			t.fn()
		}
	}
	return { table, sent, timers, fire, setReady: (v: boolean) => void (isReady = v) }
}

describe('route table', () => {
	it('a route is debounced (at least 200 ms) and the whole table is sent', () => {
		const h = harness()
		expect(h.table.note(addr(1), ARMOR, ARMOR)).toBe(true)
		expect(h.table.note(addr(2), ARMOR, ARMOR)).toBe(true)
		expect(h.timers.filter((t) => t.live)).toHaveLength(1)
		expect(h.timers[0].ms).toBeGreaterThanOrEqual(200)
		expect(ROUTE_SYNC_DEBOUNCE_MS).toBeGreaterThanOrEqual(200)
		h.fire()
		expect(h.sent).toHaveLength(1)
		expect(h.sent[0].map((r) => r.address)).toEqual([addr(1), addr(2)])
	})
	it('an unacceptable entry is skipped and changes nothing', () => {
		const h = harness()
		expect(h.table.note('not-an-address', ARMOR, ARMOR)).toBe(false)
		expect(h.table.note(addr(1), 'plain text', ARMOR)).toBe(false)
		expect(h.table.note(addr(1), ARMOR, '')).toBe(false)
		expect(h.table.note(addr(1), ARMOR + 'x'.repeat(ROUTE_ARMOR_MAX_BYTES), ARMOR)).toBe(false)
		expect(h.table.size()).toBe(0)
		expect(h.timers).toHaveLength(0)
	})
	it('at most 256 entries: the oldest drops first; the address is the lower-case key', () => {
		const h = harness()
		for (let i = 1; i <= ROUTE_TABLE_MAX_ENTRIES + 3; i++) h.table.note(addr(i), ARMOR, ARMOR)
		expect(h.table.size()).toBe(ROUTE_TABLE_MAX_ENTRIES)
		expect(h.table.has(addr(1))).toBe(false)
		expect(h.table.has(addr(ROUTE_TABLE_MAX_ENTRIES + 3))).toBe(true)
		expect(h.table.has('0x' + 'ABCDEF'.repeat(6) + 'ABCD')).toBe(false)
	})
	it('the same route again changes nothing (no send)', () => {
		const h = harness()
		h.table.note(addr(1), ARMOR, ARMOR)
		h.fire()
		h.table.note(addr(1), ARMOR, ARMOR)
		expect(h.timers.filter((t) => t.live)).toHaveLength(0)
	})
	it('a send that finds the native chat not ready keeps the table; resend() sends it again after the native chat has started', () => {
		const h = harness(false)
		h.table.note(addr(1), ARMOR, ARMOR)
		h.fire()
		expect(h.sent).toHaveLength(0)
		expect(h.table.size()).toBe(1)
		h.setReady(true)
		h.table.resend()
		h.fire()
		expect(h.sent).toHaveLength(1)
		expect(h.sent[0]).toHaveLength(1)
	})
	it('clear() (an account change or an identity clear) drops the table and a pending send: nothing of the old account is sent', () => {
		const h = harness()
		h.table.note(addr(1), ARMOR, ARMOR)
		h.table.clear()
		h.fire()
		expect(h.sent).toHaveLength(0)
		expect(h.table.size()).toBe(0)
		h.table.resend()
		expect(h.timers.filter((t) => t.live)).toHaveLength(0)
	})
})

describe('the sender side: a receipt marks Delivered', () => {
	const chat = (status: string) => ({ address: addr(9), messages: [{ id: 'a', sendId: 'S1', from: 'me', status }, { id: 'b', sendId: 'S2', from: 'them', status: 'sent' }] }) as never
	it('marks the message by sendId; a repeat is idempotent; an unknown sendId is ignored', () => {
		const first = markMessageDeliveredBySendId([chat('sent')], 'S1')
		expect(first.updated).toBe(true)
		expect((first.chats[0] as { messages: Array<{ status: string }> }).messages[0].status).toBe('delivered')
		const again = markMessageDeliveredBySendId(first.chats, 'S1')
		expect(again.updated).toBe(false)
		expect(markMessageDeliveredBySendId([chat('sent')], 'UNKNOWN').updated).toBe(false)
	})
	it('a message from the other side is never marked, and a read message is not taken back to delivered', () => {
		expect(markMessageDeliveredBySendId([chat('sent')], 'S2').updated).toBe(false)
		expect(markMessageDeliveredBySendId([chat('read')], 'S1').updated).toBe(false)
	})
})


describe('route eligibility (truth table)', () => {
	it('keep: no row, no key read, stored copy unreadable; remove: unverified, different, or the chain definitively has no valid key; offer: equal', () => {
		expect(routeEligibility({ rowKnown: false, storedVerified: 'x', freshFingerprint: 'x' })).toBe('keep')
		expect(routeEligibility({ rowKnown: true, storedVerified: 'x', freshFingerprint: undefined })).toBe('keep')
		expect(routeEligibility({ rowKnown: true, storedVerified: 'x', freshFingerprint: 'x', storedReadable: false })).toBe('keep')
		expect(routeEligibility({ rowKnown: true, storedVerified: undefined, freshFingerprint: 'x' })).toBe('remove')
		expect(routeEligibility({ rowKnown: true, storedVerified: 'x', freshFingerprint: 'y' })).toBe('remove')
		expect(routeEligibility({ rowKnown: true, storedVerified: 'x', freshFingerprint: undefined, definitiveNoKey: true })).toBe('remove')
		expect(routeEligibility({ rowKnown: false, storedVerified: 'x', freshFingerprint: undefined, definitiveNoKey: true })).toBe('keep')
		expect(routeEligibility({ rowKnown: true, storedVerified: 'x', freshFingerprint: 'x' })).toBe('offer')
	})
	it('applyRouteEligibility only offers with a route and only on the active path', () => {
		const h = harness()
		expect(applyRouteEligibility(h.table, () => true, addr(5), 'offer', undefined)).toBe('unchanged')
		expect(applyRouteEligibility(h.table, () => true, addr(5), 'offer', { publicArmored: ARMOR, routersArmoreds: ARMOR })).toBe('offered')
		expect(applyRouteEligibility(h.table, () => false, addr(5), 'remove', undefined)).toBe('unchanged')
		expect(applyRouteEligibility(h.table, () => true, addr(5), 'keep', undefined)).toBe('unchanged')
		expect(applyRouteEligibility(h.table, () => true, addr(5), 'remove', undefined)).toBe('removed')
	})
	it('readKeyOfDecision reads the key of an ok decision and of a held one', () => {
		expect(readKeyOfDecision({ ok: true, fingerprint: 'f', publicArmored: 'p', routersArmoreds: 'r' })?.fingerprint).toBe('f')
		expect(readKeyOfDecision({ ok: false, held: { fingerprint: 'g', publicArmored: 'p', routersArmoreds: 'r' } })?.fingerprint).toBe('g')
		expect(readKeyOfDecision({ ok: false })).toBeUndefined()
	})
})

describe('route table: armor and retry', () => {
	it('an armor needs both the BEGIN and the END line of a PGP public key block', () => {
		const h = harness()
		expect(h.table.note(addr(1), '-----BEGIN PGP PUBLIC KEY BLOCK-----\nX', ARMOR)).toBe(false)
		expect(h.table.note(addr(1), ARMOR, 'END PGP PUBLIC KEY BLOCK only')).toBe(false)
		expect(h.table.note(addr(1), ARMOR, ARMOR)).toBe(true)
	})
	it('a send that finds the native chat not ready is tried again after 5 s, 15 s and 60 s, three times at most; a new note starts over', () => {
		const h = harness(false)
		h.table.note(addr(1), ARMOR, ARMOR)
		h.fire()
		expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([ROUTE_SYNC_RETRY_MS[0]])
		h.fire()
		expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([ROUTE_SYNC_RETRY_MS[1]])
		h.fire()
		expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([ROUTE_SYNC_RETRY_MS[2]])
		h.fire()
		expect(h.timers.filter((t) => t.live)).toHaveLength(0)
		expect(ROUTE_SYNC_RETRY_MS).toEqual([5_000, 15_000, 60_000])
		h.table.note(addr(2), ARMOR, ARMOR)
		expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([ROUTE_SYNC_DEBOUNCE_MS])
	})
	it('a retry that succeeds sends the table and stops', () => {
		const h = harness(false)
		h.table.note(addr(1), ARMOR, ARMOR)
		h.fire()
		h.setReady(true)
		h.fire()
		expect(h.sent).toHaveLength(1)
		expect(h.timers.filter((t) => t.live)).toHaveLength(0)
	})
})
