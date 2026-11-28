/**
 * @jest-environment node
 */
// the library ACK primitives had no test, so "a failure counts as an ACK" or "the ACK is short-circuited" left every test green and would have rebuilt the G1 loss.
import { readFileSync } from 'fs'
import { join } from 'path'
import { appendHistoryAck, appendFailureCodeOf } from './historyAppendAck'

const entry = { peer: '0xaa', dir: 'out' as const, ts: 1, sendId: 's1', body: '{}' }

describe('appendHistoryAck (the ACK of history.append)', () => {
	it('no worker client: no ACK', async () => {
		expect(await appendHistoryAck(null, entry)).toBe(false)
		expect(await appendHistoryAck(undefined, entry)).toBe(false)
	})
	it('the append throws, rejects or times out: no ACK', async () => {
		expect(await appendHistoryAck({ history: { append: async () => { throw new Error('worker_timeout') } } }, entry)).toBe(false)
		expect(await appendHistoryAck({ history: { append: () => Promise.reject(new Error('refused')) } }, entry)).toBe(false)
		expect(await appendHistoryAck({ history: { append: () => { throw new Error('sync throw') } } }, entry)).toBe(false)
	})
	it('the append resolves: ACK, and exactly that entry was sent once', async () => {
		const seen: unknown[] = []
		expect(await appendHistoryAck({ history: { append: async (e: unknown) => { seen.push(e) } } }, entry)).toBe(true)
		expect(seen).toEqual([entry])
	})
	it('it does not ACK before the append has finished', async () => {
		let release: () => void = () => undefined
		const gate = new Promise<void>((r) => { release = r })
		let acked = false
		const p = appendHistoryAck({ history: { append: () => gate } }, entry).then((v) => { acked = v })
		await new Promise<void>((r) => setImmediate(r))
		expect(acked).toBe(false)
		release()
		await p
		expect(acked).toBe(true)
	})
})

describe('the bridge hands its live client to the primitive (wiring)', () => {
	const bridge = readFileSync(join(__dirname, 'chatWorkerBridge.ts'), 'utf8')
	it('appendWorkerHistoryAck is appendHistoryAck over the active client; adds only the failure code, the hook option and the success clear (no other path to a "true")', () => {
		expect(bridge).toMatch(/export const appendWorkerHistoryAck = \(entry: Omit<HistoryEntry, 'seq'>\): Promise<boolean> => \{/)
		expect(bridge).toMatch(/return appendHistoryAck\(activeClient, entry, \{/)
		expect(bridge).toMatch(/import \{ appendFailureCodeOf, appendHistoryAck, clearAppendFailure, noteAppendFailure \} from '\.\/historyAppendAck'/)
		const fn = bridge.slice(bridge.indexOf('export const appendWorkerHistoryAck'), bridge.indexOf('Global decrypted history'))
		expect(fn).toMatch(/\.then\(\(ok\) => \{\s*if \(ok\) clearAppendFailure\(entry\.sendId\)\s*return ok\s*\}\)/) // the result is the primitive's result, unchanged
		expect(fn).not.toMatch(/return true/)
	})
})

describe('an index that does not hold the record', () => {
	it('is "not confirmed as saved" (local), never "saved here, remote pending"', () => {
		expect(appendFailureCodeOf('remote_commit_failed:record_missing')).toBe('local')
		expect(appendFailureCodeOf('remote_commit_failed:pointer')).toBe('pointer')
	})
})
