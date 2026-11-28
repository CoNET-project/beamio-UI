/**
 * @jest-environment node
 *
 * the mirror of one inbound message line (inboundMirror.ts). Synthetic rows; the worker is a fake.
 */
import { inboundMirrorFor } from './inboundMirror'

type Row = { sendId?: unknown; text: string }
const row: Row = { sendId: 'send-1', text: 'synthetic' }

describe('every browser message line gets an append promise, whatever the persistence mode reads', () => {
	it('browser + a new row: the append is started at once, handed over as a mirror, and a retry asks again', async () => {
		const calls: string[] = []
		const ff: string[] = []
		const m = inboundMirrorFor<Row>({ browser: true, isNew: true, peer: '0xpeer', added: row, ack: async (p, r, d) => { calls.push(`${p}|${r.sendId}|${d}`); return true }, fireAndForget: () => { ff.push('x') } })
		expect(m).toBeDefined()
		expect(calls).toEqual(['0xpeer|send-1|in'])
		expect(await (m as NonNullable<typeof m>).done).toBe(true)
		expect(await (m as NonNullable<typeof m>).retry()).toBe(true)
		expect(calls.length).toBe(2)
		expect((m as NonNullable<typeof m>).sendId).toBe('send-1')
		expect(ff).toEqual([]) // no second, fire-and-forget copy
	})
	it('browser + a DUPLICATE copy of a row gets its append too (idempotent by sendId): its ACK waits for it', async () => {
		let n = 0
		const m = inboundMirrorFor<Row>({ browser: true, isNew: false, peer: 'p', added: row, ack: async () => { n += 1; return true }, fireAndForget: () => { throw new Error('must not be called') } })
		expect(m).toBeDefined()
		expect(await (m as NonNullable<typeof m>).done).toBe(true)
		expect(n).toBe(1)
	})
	it('a worker that throws is an unconfirmed append (false), not a crash', async () => {
		const m = inboundMirrorFor<Row>({ browser: true, isNew: true, peer: 'p', added: row, ack: async () => { throw new Error('worker gone') }, fireAndForget: () => undefined })
		expect(await (m as NonNullable<typeof m>).done).toBe(false)
	})
	it('a row without a string sendId carries no sendId (it cannot be marked unsaved)', () => {
		const m = inboundMirrorFor<Row>({ browser: true, isNew: true, peer: 'p', added: { text: 'x' }, ack: async () => true, fireAndForget: () => undefined })
		expect((m as NonNullable<typeof m>).sendId).toBeUndefined()
	})
	it('a browser line whose row cannot be found returns NO mirror, is counted, and does NOT fall back to the old fire-and-forget call', () => {
		let counted = 0
		const ff: unknown[] = []
		const m = inboundMirrorFor<Row>({ browser: true, isNew: true, peer: 'p', added: null, ack: async () => true, fireAndForget: (...a) => { ff.push(a) }, onUnmirrored: () => { counted += 1 } })
		expect(m).toBeUndefined()
		expect(counted).toBe(1)
		expect(ff).toEqual([]) // that fallback let the settle step ACK the line with no copy anywhere
	})
	it('a native shell keeps the old fire-and-forget mirror for a new row and returns no promise; a duplicate is not mirrored again', () => {
		const ff: Array<Row | undefined> = []
		const m = inboundMirrorFor<Row>({ browser: false, isNew: true, peer: 'p', added: row, ack: async () => { throw new Error('must not be asked') }, fireAndForget: (_p, r) => { ff.push(r) } })
		expect(m).toBeUndefined()
		expect(ff).toEqual([row])
		const m2 = inboundMirrorFor<Row>({ browser: false, isNew: false, peer: 'p', added: row, ack: async () => true, fireAndForget: (_p, r) => { ff.push(r) } })
		expect(m2).toBeUndefined()
		expect(ff).toEqual([row])
	})
	it('a native line with nothing to mirror: the old call with no row, no promise', () => {
		const ff: Array<Row | undefined> = []
		const m = inboundMirrorFor<Row>({ browser: false, isNew: true, peer: 'p', added: null, ack: async () => true, fireAndForget: (_p, r) => { ff.push(r) } })
		expect(m).toBeUndefined()
		expect(ff).toEqual([undefined])
	})
})
