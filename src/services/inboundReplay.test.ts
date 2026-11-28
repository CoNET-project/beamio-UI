/**
 * @jest-environment node
 *
 * which replayed lines may be ACKed (inboundReplay.ts). Synthetic lines.
 */
import { planReplayAcks } from './inboundReplay'

const marked = new Set(['MARKED-ROW', 'MARKED-CTL'])
const hasMarker = (l: string): boolean => marked.has(l)

describe('a replayed line is ACKed in the browser only when it carries a dedupe marker', () => {
	it('(b) a replayed row that is still in flight (no marker) is held: not ACKed, not passed as a row either', () => {
		const p = planReplayAcks({ browser: true, rows: ['INFLIGHT-ROW'], drops: [], hasMarker })
		expect(p.rowLines).toEqual([])
		expect(p.dropLines).toEqual([])
		expect(p.held).toEqual(['INFLIGHT-ROW'])
	})
	it('a chat line replayed while its first copy is still being processed lands in the "drops" of App (processed, row not stored yet): without a marker it is held too', () => {
		const p = planReplayAcks({ browser: true, rows: [], drops: ['CHAT-IN-FLIGHT'], hasMarker })
		expect(p.dropLines).toEqual([])
		expect(p.held).toEqual(['CHAT-IN-FLIGHT'])
	})
	it('a replayed line with a marker (its append was confirmed, or it was dropped on purpose) is ACKed again, as a dropped line', () => {
		const p = planReplayAcks({ browser: true, rows: ['MARKED-ROW'], drops: ['MARKED-CTL', 'UNMARKED-CTL'], hasMarker })
		expect(p.rowLines).toEqual([])
		expect(p.dropLines).toEqual(['MARKED-ROW', 'MARKED-CTL'])
		expect(p.held).toEqual(['UNMARKED-CTL'])
		expect(p.confirmed).toEqual(['MARKED-ROW', 'MARKED-CTL'])
	})
	it('a marker check that throws holds the line', () => {
		const p = planReplayAcks({ browser: true, rows: ['A'], drops: [], hasMarker: () => { throw new Error('store gone') } })
		expect(p.held).toEqual(['A'])
		expect(p.dropLines).toEqual([])
	})
	it('a native shell keeps the old split and ignores the marker', () => {
		const p = planReplayAcks({ browser: false, rows: ['R'], drops: ['D'], hasMarker: () => false })
		expect(p).toEqual({ rowLines: ['R'], dropLines: ['D'], held: [], confirmed: [] })
	})
})
