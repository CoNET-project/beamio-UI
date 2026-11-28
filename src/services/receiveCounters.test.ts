/**
 * @jest-environment node
 */
// the receiving side's counters (receiveCounters.ts), hook variant only: per sendId arrivals, dedupe hits, receipts actually sent; a received receipt is not a sent one.
import { readFileSync } from 'fs'
import { join } from 'path'
import { resetReceiveCountersForTest, rxNote, rxSnapshot } from './receiveCounters'

const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
beforeEach(() => resetReceiveCountersForTest())

describe('the counters', () => {
	it('the same sendId arriving twice: arrivals 2, dedupe hits 1, and the receipts count only what was sent', () => {
		const ID = '1767225600000-aaaa1111'
		rxNote('arr', ID) // the first arrival: a new row, a receipt attempted and sent
		rxNote('re', ID)
		rxNote('ro', ID)
		rxNote('arr', ID) // the second arrival of the same line: a dedupe hit, no second receipt
		rxNote('dd', ID)
		const row = rxSnapshot().ids.find((r) => r.id === 'aaaa1111')
		expect(row).toMatchObject({ arr: 2, dd: 1, re: 1, ro: 1, rf: 0, rk: 0 })
		expect(rxSnapshot().totals).toMatchObject({ arr: 2, dd: 1, re: 1, ro: 1 })
	})
	it('a received receipt (ra) is never counted as a sent one (re / ro): they are separate counters', () => {
		rxNote('ra', 'x-bbbb2222')
		rxNote('ra', 'x-bbbb2222')
		const t = rxSnapshot().totals
		expect(t.ra).toBe(2)
		expect(t.re + t.ro + t.rf + t.rk + t.rn).toBe(0)
	})
	it('skipped (no verified key), failed and native-left receipts have their own counters', () => {
		rxNote('rk', 'a-cccc3333'); rxNote('rf', 'a-cccc3333'); rxNote('rn', 'a-cccc3333')
		expect(rxSnapshot().ids[0]).toMatchObject({ id: 'cccc3333', rk: 1, rf: 1, rn: 1, ro: 0, re: 0 })
	})
	it('ids are cut to 8 characters, the table is bounded (24 ids, newest kept), totals keep counting; an empty id only counts in the totals', () => {
		for (let i = 0; i < 40; i++) rxNote('arr', `id-${String(i).padStart(8, '0')}`)
		const snap = rxSnapshot()
		expect(snap.ids.length).toBe(24)
		expect(snap.ids[snap.ids.length - 1].id).toBe('00000039')
		expect(snap.totals.arr).toBe(40)
		rxNote('dd', '')
		expect(rxSnapshot().totals.dd).toBe(1)
		expect(rxSnapshot().ids.length).toBe(24)
		expect(rxSnapshot().ids.every((r) => r.id.length <= 8)).toBe(true)
	})
	it('the module has no text, address or storage and never logs', () => {
		const code = src('receiveCounters.ts').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(code).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|debugLog|fetch\(|WebSocket/)
	})
})

describe('hook variant only: every call site sits behind the compile-time switch', () => {
	const app = src('../App.tsx')
	it('each rxNote call in App.tsx is guarded by process.env.REACT_APP_QA_ACK_ORDER_HOOK === \'true\' on the same line (the minifier removes the call and its strings with the switch)', () => {
		const lines = app.split('\n').filter((l) => /\brxNote\(/.test(l) && !/^import /.test(l.trim()))
		expect(lines.length).toBeGreaterThanOrEqual(7)
		for (const l of lines) expect(l).toMatch(/process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'/)
	})
	it('the sites: arrival and dedupe in the batch loop, row exists, receipt arrived, native, attempted/skipped, sent/failed', () => {
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && key\) rxNote\('arr', key\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && key\) rxNote\('dd', key\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && !isNew\) rxNote\('dd', extractInboundSendId\(displayText\) \|\| ''\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) rxNote\('ra', deliveryReceipt\.sendId\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && nativeReceiptPath\(\)\) rxNote\('rn', inboundSendId \|\| ''\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true'\) rxNote\(receiptSender\.ok \? 're' : 'rk', inboundSendId \|\| ''\)/)
		expect(app).toMatch(/if \(process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && receiptSender\.ok\) rxNote\(sentReceipt\.senderReceipt === 'sent' \? 'ro' : 'rf', inboundSendId \|\| ''\)/)
	})
	it('nothing outside App.tsx, qaAckOrder.ts and the module itself uses the counters; the state export reads them only through the hook file', () => {
		const qa = src('../utils/qaAckOrder.ts')
		expect(qa).toMatch(/import \{ rxSnapshot \} from '@\/services\/receiveCounters'/)
		for (const f of ['chatDeliveryReceipt.ts']) expect(readFileSync(join(__dirname, '../utils', f), 'utf8')).not.toMatch(/rxNote|receiveCounters/)
	})
	it('the sender receipt reports what it did (sent / failed / skipped) so "sent" is a fact and not a guess', () => {
		const r = readFileSync(join(__dirname, '../utils/chatDeliveryReceipt.ts'), 'utf8')
		expect(r).toMatch(/Promise<DualReceiptOutcome>/)
		expect(r).toMatch(/senderReceipt = ok \? 'sent' : 'failed'/)
		expect(r).toMatch(/return \{ senderReceipt \}/)
	})
})
