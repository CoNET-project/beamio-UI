/**
 * @jest-environment node
 */
/**
 * The real receipt-route trust logic (receiptRouteTrust.ts, the same module chat.ts wires) driven through its two entries, with the route table real and
 * the stored copy, the in-memory row and the key read faked. SYNTHETIC addresses, keys and fingerprints.
 */
import { createReceiptRouteTrust, createStoredTrustReader, invalidateStoredTrust, type StoredTrust, type TrustDecisionLike } from './receiptRouteTrust'
import { createRouteTable, applyRouteEligibility, type RouteEntry } from './nativeRouteTable'
import { createOfferGate } from './routeOfferGate'

const A = '0x' + 'aa'.repeat(20)
const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nSYNTHETIC\n-----END PGP PUBLIC KEY BLOCK-----'
const FP = 'f'.repeat(40)
const OTHER_FP = 'e'.repeat(40)

type World = {
	mem: { hasRow: boolean; verified?: string }
	stored: StoredTrust | 'throw'
	reads: number
	nextDecision: TrustDecisionLike
}

function setup(world: World) {
	const sent: RouteEntry[][] = []
	const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
	const table = createRouteTable({
		send: (r) => (sent.push(r), true),
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true }
			timers.push(t)
			return t
		},
		clearTimer: (t) => void ((t as { live: boolean }).live = false),
	})
	const logs: string[] = []
	let now = 0
	let trust: ReturnType<typeof createReceiptRouteTrust>
	const deps = {
		memoryRow: () => world.mem,
		storedTrust: async () => {
			if (world.stored === 'throw') throw new Error('idb')
			return world.stored
		},
		apply: (address: string, el: never, route: never) => applyRouteEligibility(table, () => true, address, el, route),
		readKey: async (address: string) => {
			world.reads += 1
			await trust.observe(address, world.nextDecision)
		},
		gate: createOfferGate(() => now, 3 * 60 * 1000),
		log: (l: string) => void logs.push(l),
	}
	trust = createReceiptRouteTrust(deps as never)
	const fire = () => {
		const t = timers.find((x) => x.live)
		if (t) {
			t.live = false
			t.fn()
		}
	}
	return { trust, table, sent, timers, fire, logs, advance: (ms: number) => void (now += ms) }
}
const ok = (fingerprint: string): TrustDecisionLike => ({ ok: true, fingerprint, publicArmored: ARMOR, routersArmoreds: ARMOR })
const held = (code: string, fingerprint: string): TrustDecisionLike => ({ ok: false, code, held: { fingerprint, publicArmored: ARMOR, routersArmoreds: ARMOR } })
const base = (over: Partial<World> = {}): World => ({ mem: { hasRow: true, verified: undefined }, stored: { readable: true, hasRow: true, verified: FP }, reads: 0, nextDecision: ok(FP), ...over })

describe('observer: the STORED copy decides, not the in-memory row', () => {
	it('a verified contact (stored fingerprint equals the key) is offered', async () => {
		const w = base()
		const h = setup(w)
		await h.trust.observe(A, ok(FP))
		expect(h.table.has(A)).toBe(true)
	})
	it('the in-memory row lacks the fingerprint (a decision first_fetch_pending from a memory copy) but the stored copy has it: the route is NOT removed and no empty table is sent', async () => {
		const w = base({ mem: { hasRow: true, verified: undefined } })
		const h = setup(w)
		await h.trust.observe(A, ok(FP))
		h.fire()
		expect(h.sent.at(-1)).toHaveLength(1)
		await h.trust.observe(A, held('first_fetch_pending', FP))
		expect(h.table.has(A)).toBe(true)
		h.fire()
		expect(h.sent.at(-1)).toHaveLength(1)
		expect(h.sent.every((t) => t.length === 1)).toBe(true)
	})
	it('the in-memory row has a fingerprint but it was never stored (the save failed): the contact is NOT offered', async () => {
		const w = base({ mem: { hasRow: true, verified: FP }, stored: { readable: true, hasRow: true, verified: undefined } })
		const h = setup(w)
		await h.trust.observe(A, ok(FP))
		expect(h.table.has(A)).toBe(false)
		expect(h.sent).toHaveLength(0)
	})
	it('the fingerprint really changed: removed, and the whole table (empty) is sent within one debounce period', async () => {
		const w = base()
		const h = setup(w)
		await h.trust.observe(A, ok(FP))
		h.fire()
		await h.trust.observe(A, held('fingerprint_changed', OTHER_FP))
		expect(h.table.has(A)).toBe(false)
		const pending = h.timers.filter((t) => t.live)
		expect(pending).toHaveLength(1)
		expect(pending[0].ms).toBe(200)
		h.fire()
		expect(h.sent.at(-1)).toHaveLength(0)
	})
	it('the chain definitively has no valid key (no record, an invalid key): removed; a network or internal error keeps the offered contact', async () => {
		for (const code of ['recipient_no_record', 'recipient_key_invalid']) {
			const h = setup(base())
			await h.trust.observe(A, ok(FP))
			await h.trust.observe(A, { ok: false, code })
			expect(h.table.has(A)).toBe(false)
		}
		for (const code of ['route_unconfirmed', 'recipient_key_unavailable']) {
			const h = setup(base())
			await h.trust.observe(A, ok(FP))
			await h.trust.observe(A, { ok: false, code })
			expect(h.table.has(A)).toBe(true)
		}
	})
	it('a stored copy that cannot be read (or throws) neither offers nor removes', async () => {
		for (const stored of [{ readable: false, hasRow: false } as StoredTrust, 'throw' as const]) {
			const h = setup(base({ stored }))
			await h.trust.observe(A, ok(FP))
			expect(h.table.has(A)).toBe(false)
		}
		const h = setup(base())
		await h.trust.observe(A, ok(FP))
		const w2 = { ...base(), stored: 'throw' as const }
		const h2 = setup(w2)
		h2.table.note(A, ARMOR, ARMOR)
		await h2.trust.observe(A, held('first_fetch_pending', FP))
		expect(h2.table.has(A)).toBe(true)
		void h
	})
	it('a contact with no row anywhere is left alone', async () => {
		const h = setup(base({ mem: { hasRow: false }, stored: { readable: true, hasRow: false } }))
		h.table.note(A, ARMOR, ARMOR)
		await h.trust.observe(A, held('fingerprint_changed', OTHER_FP))
		expect(h.table.has(A)).toBe(true)
	})
})

describe('offer (inbound sender, cold start, after a verification)', () => {
	it('the in-memory row lost the fingerprint but the stored copy has it: the key is read and the route stays (the inbound path)', async () => {
		const w = base({ mem: { hasRow: true, verified: undefined } })
		const h = setup(w)
		h.table.note(A, ARMOR, ARMOR)
		h.fire()
		await h.trust.offer(A)
		expect(w.reads).toBe(1)
		expect(h.table.has(A)).toBe(true)
		h.fire()
		expect(h.sent.every((t) => t.length === 1)).toBe(true)
	})
	it('a contact the STORED copy shows as unverified is judged without any network read and removed if it was offered', async () => {
		const w = base({ stored: { readable: true, hasRow: true, verified: undefined } })
		const h = setup(w)
		h.table.note(A, ARMOR, ARMOR)
		await h.trust.offer(A)
		expect(w.reads).toBe(0)
		expect(h.table.has(A)).toBe(false)
	})
	it('a stored copy that cannot be read changes nothing and reads nothing', async () => {
		const w = base({ stored: { readable: false, hasRow: false } })
		const h = setup(w)
		h.table.note(A, ARMOR, ARMOR)
		await h.trust.offer(A)
		expect(w.reads).toBe(0)
		expect(h.table.has(A)).toBe(true)
	})
	it('a burst of offers for one contact is one read; force (a verification just saved) reads again', async () => {
		const w = base()
		const h = setup(w)
		await Promise.all([h.trust.offer(A), h.trust.offer(A), h.trust.offer(A)])
		expect(w.reads).toBe(1)
		await h.trust.offer(A)
		expect(w.reads).toBe(1)
		await h.trust.offer(A, { force: true })
		expect(w.reads).toBe(2)
	})
	it('after the verification is stored, the contact is offered by the next read', async () => {
		const w = base({ stored: { readable: true, hasRow: true, verified: undefined } })
		const h = setup(w)
		await h.trust.offer(A)
		expect(h.table.has(A)).toBe(false)
		w.stored = { readable: true, hasRow: true, verified: FP }
		await h.trust.offer(A, { force: true })
		expect(h.table.has(A)).toBe(true)
	})
	it('a contact with no row anywhere is not read', async () => {
		const w = base({ mem: { hasRow: false }, stored: { readable: true, hasRow: false } })
		const h = setup(w)
		await h.trust.offer(A)
		expect(w.reads).toBe(0)
	})
})

describe('a network error never offers a contact, a changed fingerprint is not throttled', () => {
	it('a network error for a contact not yet offered does not offer it', async () => {
		for (const code of ['route_unconfirmed', 'recipient_key_unavailable']) {
			const h = setup(base())
			await h.trust.observe(A, { ok: false, code })
			expect(h.table.has(A)).toBe(false)
		}
	})
	it('inside the 3-minute inbound spacing a changed fingerprint still removes the contact at once (the observer is not behind the gate)', async () => {
		const w = base()
		const h = setup(w)
		await h.trust.offer(A)
		expect(h.table.has(A)).toBe(true)
		await h.trust.offer(A)
		expect(w.reads).toBe(1)
		await h.trust.observe(A, held('fingerprint_changed', OTHER_FP))
		expect(h.table.has(A)).toBe(false)
		const pending = h.timers.filter((t) => t.live)
		expect(pending.at(-1)?.ms).toBe(200)
	})
})

describe('stored-copy reader: one shared read, null is unreadable, a row only in the stored copy counts', () => {
	const FPR = (raw: string | null | undefined) => (typeof raw === 'string' && raw ? raw : undefined)
	const rows = [{ chats: [{ address: A.toUpperCase().replace('0X', '0x'), chatData: { verifiedFingerprint: FP } }] }]
	const mk = (read: () => Promise<never>, t = { now: 0 }) => ({ t, r: createStoredTrustReader(read, { now: () => t.now, ttlMs: 1500, readFingerprint: FPR }) })

	it('a null record is unreadable (not "readable, no row")', async () => {
		const { r } = mk(async () => null as never)
		expect(await r.read(A)).toEqual({ readable: false, hasRow: false })
	})
	it('a row that exists only in the stored copy is found (address compared lower-case) with its fingerprint', async () => {
		const { r } = mk(async () => rows as never)
		expect(await r.read(A)).toEqual({ readable: true, hasRow: true, verified: FP })
		expect(await r.read('0x' + 'bb'.repeat(20))).toEqual({ readable: true, hasRow: false, verified: undefined })
	})
	it('a burst for many addresses and many messages reads the record once; the cache expires; invalidate and a failed read force a new read', async () => {
		let n = 0
		let fail = false
		const { r, t } = mk(async () => {
			n += 1
			if (fail) return null as never
			return rows as never
		})
		await Promise.all([r.read(A), r.read(A), r.read(A), r.read('0x' + 'bb'.repeat(20))])
		expect(n).toBe(1)
		await r.read(A)
		expect(n).toBe(1)
		t.now = 1600
		await r.read(A)
		expect(n).toBe(2)
		r.invalidate()
		await r.read(A)
		expect(n).toBe(3)
		t.now = 5000
		fail = true
		expect((await r.read(A)).readable).toBe(false)
		fail = false
		expect((await r.read(A)).readable).toBe(true)
		expect(n).toBe(5)
	})
})

describe('a row only in the stored copy (none in memory) counts as a known contact', () => {
	it('observer: offered when the stored fingerprint equals the key, and removed when it differs', async () => {
		const h = setup(base({ mem: { hasRow: false } }))
		await h.trust.observe(A, ok(FP))
		expect(h.table.has(A)).toBe(true)
		await h.trust.observe(A, held('fingerprint_changed', OTHER_FP))
		expect(h.table.has(A)).toBe(false)
	})
	it('offer: reads the key once for such a contact and offers it', async () => {
		const w = base({ mem: { hasRow: false } })
		const h = setup(w)
		await h.trust.offer(A)
		expect(w.reads).toBe(1)
		expect(h.table.has(A)).toBe(true)
	})
})

describe('stored-copy reader: account change and a read that was running when the user verified', () => {
	const FPR = (raw: string | null | undefined) => (typeof raw === 'string' && raw ? raw : undefined)
	const rowWith = (fp?: string) => [{ chats: [{ address: A, chatData: { verifiedFingerprint: fp } }] }]
	it('after the account changed (invalidateStoredTrust) the next read goes to the store again, inside the cache time, and sees the new account', async () => {
		let account: 'A' | 'B' = 'A'
		let n = 0
		const r = createStoredTrustReader(async () => (n++, account === 'A' ? (rowWith(FP) as never) : (rowWith(undefined) as never)), { now: () => 0, ttlMs: 1500, readFingerprint: FPR })
		expect((await r.read(A)).verified).toBe(FP)
		account = 'B'
		invalidateStoredTrust()
		expect((await r.read(A)).verified).toBeUndefined()
		expect(n).toBe(2)
	})
	it('a read that is still running when the user verifies is not joined: the read after invalidate starts a new one and sees the verified value; the old result is not cached', async () => {
		let stored = rowWith(undefined)
		const gates: Array<() => void> = []
		let n = 0
		const r = createStoredTrustReader(
			() => {
				n += 1
				const snapshot = stored
				return new Promise((res) => gates.push(() => res(snapshot as never)))
			},
			{ now: () => 0, ttlMs: 1500, readFingerprint: FPR },
		)
		const old = r.read(A)
		stored = rowWith(FP)
		r.invalidate()
		const fresh = r.read(A)
		expect(n).toBe(2)
		gates[1]()
		expect((await fresh).verified).toBe(FP)
		gates[0]()
		expect((await old).verified).toBeUndefined()
		expect((await r.read(A)).verified).toBe(FP)
		expect(n).toBe(2)
	})
})

describe('wiring: clearing the route state also drops the stored-record cache', () => {
	it('clearNativeRouteState calls invalidateStoredTrust', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chatWorkerBridge.ts'), 'utf8') as string
		const body = src.slice(src.indexOf('export const clearNativeRouteState'), src.indexOf('export const clearNativeRouteState') + 220)
		expect(body).toContain('invalidateStoredTrust()')
	})
})

describe('stored-copy reader: pinned details', () => {
	const FPR = (raw: string | null | undefined) => (typeof raw === 'string' && raw ? raw : undefined)
	it('an old read that ends after an invalidation does not clear the newer running read: a third read joins the newer one', async () => {
		const gates: Array<() => void> = []
		let n = 0
		const r = createStoredTrustReader(
			() => {
				n += 1
				return new Promise((res) => gates.push(() => res([{ chats: [] }] as never)))
			},
			{ now: () => 0, ttlMs: 1500, readFingerprint: FPR },
		)
		const old = r.read(A)
		r.invalidate()
		const newer = r.read(A)
		expect(n).toBe(2)
		gates[0]()
		await old
		const third = r.read(A)
		expect(n).toBe(2)
		gates[1]()
		await Promise.all([newer, third])
	})
	it('the forced contact offer drops the stored-record cache before it reads (wiring in chat.ts)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chat.ts'), 'utf8') as string
		const at = src.indexOf('export const offerContactRoute')
		const body = src.slice(at, at + 260)
		expect(body).toContain('if (opts?.force) storedTrustReader.invalidate()')
		expect(body.indexOf('storedTrustReader.invalidate()')).toBeLessThan(body.indexOf('receiptRouteTrust.offer('))
	})
})
