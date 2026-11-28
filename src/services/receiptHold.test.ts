/**
 * @jest-environment node
 */
// the bookkeeping of the receipt step (receiptHold.ts): unreadable streaks, held-line back-off, counters; and the wiring of the held lines in App.tsx.
import { readFileSync } from 'fs'
import { join } from 'path'
import {
	HELD_LINE_STEPS_MS,
	UNREADABLE_PERMANENT_MS,
	UNREADABLE_PERMANENT_READINGS,
	createHeldLineTracker,
	createUnreadableTracker,
	heldLineDelayMs,
	newReceiptHoldStats,
	receiptHoldStatsSnapshot,
	resetReceiptHoldStatsForTest,
} from './receiptHold'

describe('the unreadable streak', () => {
	it('three readings in a row make it permanent; two do not', () => {
		const t = createUnreadableTracker(() => 1000)
		expect(UNREADABLE_PERMANENT_READINGS).toBe(3)
		expect(t.note('s1')).toEqual({ count: 1, permanent: false, becamePermanent: false })
		expect(t.note('s1')).toEqual({ count: 2, permanent: false, becamePermanent: false })
		expect(t.note('s1')).toEqual({ count: 3, permanent: true, becamePermanent: true })
		expect(t.note('s1')).toEqual({ count: 4, permanent: true, becamePermanent: false }) // counted once per streak
	})
	it('ten minutes since the first reading make it permanent even with two readings', () => {
		let now = 5_000
		const t = createUnreadableTracker(() => now)
		expect(t.note('s1').permanent).toBe(false)
		now += UNREADABLE_PERMANENT_MS - 1
		expect(t.note('s1')).toEqual({ count: 2, permanent: false, becamePermanent: false })
		now += 1
		expect(t.note('s1')).toEqual({ count: 3, permanent: true, becamePermanent: true })
		expect(UNREADABLE_PERMANENT_MS).toBe(10 * 60 * 1000)
		now += 10
		const u = createUnreadableTracker(() => now)
		u.note('x')
		now += UNREADABLE_PERMANENT_MS
		expect(u.note('x')).toEqual({ count: 2, permanent: true, becamePermanent: true })
	})
	it('permanentCount: how many sendIds are permanently unreadable NOW (a gauge); a clear removes one', () => {
		const t = createUnreadableTracker(() => 1)
		for (let i = 0; i < 3; i++) { t.note('a'); t.note('b') }
		t.note('c')
		expect(t.permanentCount()).toBe(2)
		t.clear('a')
		expect(t.permanentCount()).toBe(1)
	})
	it('the streaks are per sendId, a clear (a readable or absent reading) ends one, and the memory is bounded', () => {
		const t = createUnreadableTracker(() => 1)
		t.note('a'); t.note('a')
		expect(t.note('b').count).toBe(1)
		t.clear('a')
		expect(t.note('a').count).toBe(1)
		for (let i = 0; i < 1100; i++) t.note(`s${i}`)
		expect(t.size()).toBeLessThanOrEqual(1000)
	})
})

describe('the held-line back-off', () => {
	it('5 s, 15 s, 60 s, then 5 minutes at most; a clear starts again; bounded memory', () => {
		expect([...HELD_LINE_STEPS_MS]).toEqual([5_000, 15_000, 60_000, 300_000])
		const t = createHeldLineTracker()
		expect([1, 2, 3, 4, 5, 9].map((n) => heldLineDelayMs(n))).toEqual([5_000, 15_000, 60_000, 300_000, 300_000, 300_000])
		expect(heldLineDelayMs(0)).toBe(5_000)
		expect(t.hold('L')).toEqual({ attempt: 1, delayMs: 5_000 })
		expect(t.hold('L')).toEqual({ attempt: 2, delayMs: 15_000 })
		expect(t.hold('M').attempt).toBe(1)
		t.clear('L')
		expect(t.hold('L').attempt).toBe(1)
		for (let i = 0; i < 600; i++) t.hold(`l${i}`)
		expect(t.size()).toBeLessThanOrEqual(500)
	})
})

describe('the counters', () => {
	it('numbers only; a snapshot is a copy; the page-wide counters can be reset for tests', () => {
		resetReceiptHoldStatsForTest()
		expect(receiptHoldStatsSnapshot()).toEqual(newReceiptHoldStats())
		const snap = receiptHoldStatsSnapshot()
		snap.held = 99
		expect(receiptHoldStatsSnapshot().held).toBe(0)
		expect(Object.values(newReceiptHoldStats()).every((v) => typeof v === 'number')).toBe(true)
	})
	it('receiptHold.ts never logs and never stores', () => {
		const src = readFileSync(join(__dirname, 'receiptHold.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|debugLog/)
	})
})

describe('App.tsx: a held receipt line is forgotten by the page and put back into the normal path with the back-off', () => {
	const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
	it('each receipt keeps its mailbox line; the trackers are page refs', () => {
		expect(app).toMatch(/batchDelivered\.push\(\{ sendId: deliveryReceipt\.sendId, from: signAddr, line: raw \}\)/)
		expect(app).toMatch(/const receiptUnreadableRef = useRef\(createUnreadableTracker\(\)\)/)
		expect(app).toMatch(/const heldLinesRef = useRef\(createHeldLineTracker\(\)\)/)
	})
	it('onHeld forgets the key (so the redelivery is processed, not taken as handled) and schedules the line again; the step answers with the held lines only', () => {
		const at = app.indexOf('onHeld: (lines) => {')
		expect(at).toBeGreaterThan(0)
		const body = app.slice(at, at + 700)
		expect(body).toContain('processedIdsRef.current.delete(key)')
		expect(body).toContain('heldLinesRef.current.hold(line)')
		expect(body).toMatch(/window\.setTimeout\(\(\) => setChartsRef\.current\(\(prev: string\[\]\) => \[\.\.\.prev, line\]\), plan\.delayMs\)/)
		expect(app).toMatch(/return \{ heldLines \}/)
		expect(app).toMatch(/unreadable: receiptUnreadableRef\.current/)
	})
	it('the settle call keeps its shape (the ACK static tests pin it)', () => {
		expect(app).toContain('settleInboundBatch(settleInputOf(inboundLists), {')
	})
})
