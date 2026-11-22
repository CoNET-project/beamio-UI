/**
 * The silent cleanup after a verified recovery. Behaviour-level: a fake store, a fake page read and a fake native
 * send. Cases: recovery ok and the read-backs agree → one send with the derived key, the marker cleared; a failed, incomplete or refused
 * recovery, an unreadable page address, a mismatch, a repeat and a concurrent repeat → no second send and nothing deleted by this code.
 */
import { CLEANUP_PENDING_KEY, cleanupAfterVerifiedRecovery, resetCleanupGuardsForTest, startCleanupAfterRecovery } from './accountCleanupPending'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)

function memStore() {
	const m = new Map<string, string>()
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		has: (k: string) => m.has(k),
	}
}
let seq = 0
const newKey = () => `k${++seq}`
const okSend = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: true } })
const pageRead = (addr: unknown) => () => Promise.resolve(addr)

describe('the silent cleanup: verified recovery starts it once; anything else deletes nothing', () => {
	beforeEach(() => resetCleanupGuardsForTest())
	it('recovery ok and the read-backs agree → one send with the derived (lower-case) key; the marker is cleared', async () => {
		const store = memStore()
		const sent: string[] = []
		const send = (cmd: { accountKey: string }) => { sent.push(cmd.accountKey); return okSend() }
		const out = await cleanupAfterVerifiedRecovery(store, A.toUpperCase().replace('0X', '0x'), pageRead(A), send)
		expect(out).toEqual({ kind: 'ok' })
		expect(sent).toEqual([A])
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('a failed recovery (no native address) → no send, nothing started', async () => {
		const store = memStore()
		const sent: string[] = []
		const out = await cleanupAfterVerifiedRecovery(store, null, pageRead(A), (c) => { sent.push(c.accountKey); return okSend() })
		expect(out).toBeNull()
		expect(sent).toEqual([])
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('a read-back mismatch → no send, no marker', async () => {
		const store = memStore()
		const sent: string[] = []
		const out = await cleanupAfterVerifiedRecovery(store, B, pageRead(A), (c) => { sent.push(c.accountKey); return okSend() })
		expect(out).toBeNull()
		expect(sent).toEqual([])
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('an unreadable page address → no send (no command without the derived key)', async () => {
		const store = memStore()
		const sent: string[] = []
		const out = await cleanupAfterVerifiedRecovery(store, A, pageRead(null), (c) => { sent.push(c.accountKey); return okSend() })
		expect(out).toBeNull()
		expect(sent).toEqual([])
	})

	it('a page read that throws → no send', async () => {
		const store = memStore()
		const sent: string[] = []
		const out = await cleanupAfterVerifiedRecovery(store, A, () => Promise.reject(new Error('read failed')), (c) => { sent.push(c.accountKey); return okSend() })
		expect(out).toBeNull()
		expect(sent).toEqual([])
	})

	it('a refused answer keeps the marker (journal) and is not done: a later verified recovery may run it again', async () => {
		const store = memStore()
		const refused = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_incomplete_x' } })
		const first = await startCleanupAfterRecovery(store, A, newKey, refused)
		expect(first.kind).not.toBe('ok')
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		const again = await startCleanupAfterRecovery(store, A, newKey, okSend)
		expect(again).toEqual({ kind: 'ok' })
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})

	it('a repeated callback after ok → no second send (never a second deletion)', async () => {
		const store = memStore()
		const sent: string[] = []
		const send = (c: { accountKey: string }) => { sent.push(c.accountKey); return okSend() }
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		const second = await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		expect(second).toBeNull()
		expect(sent).toEqual([A])
	})

	it('a refresh or restart (the in-memory guard is gone, the page storage is kept): the same account is not sent again', async () => {
		const store = memStore()
		const sent: string[] = []
		const send = (c: { accountKey: string }) => { sent.push(c.accountKey); return okSend() }
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		expect(sent).toEqual([A])
		// a restart: the process memory is cleared, the page storage (the done mark) survives
		resetCleanupGuardsForTest()
		const after = await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		expect(after).toBeNull()
		expect(sent).toEqual([A])
	})

	it('a restart after a refused answer (no done mark): the account may run again on a verified recovery', async () => {
		const store = memStore()
		const refused = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'bad_request' } })
		await startCleanupAfterRecovery(store, A, newKey, refused)
		resetCleanupGuardsForTest()
		const again = await cleanupAfterVerifiedRecovery(store, A, pageRead(A), okSend)
		expect(again).toEqual({ kind: 'ok' })
	})

	it('B→A→B: the second recovery of B (a new recovery after the account changed) is sent with a new key', async () => {
		const store = memStore()
		const sent: Array<{ accountKey: string; idempotencyKey: string }> = []
		const send = (c: { accountKey: string; idempotencyKey: string }) => { sent.push({ accountKey: c.accountKey, idempotencyKey: c.idempotencyKey }); return okSend() }
		await cleanupAfterVerifiedRecovery(store, B, pageRead(B), send)
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		const again = await cleanupAfterVerifiedRecovery(store, B, pageRead(B), send)
		expect(again).toEqual({ kind: 'ok' })
		expect(sent.map((s) => s.accountKey)).toEqual([B, A, B])
		expect(new Set(sent.map((s) => s.idempotencyKey)).size).toBe(3)
	})

	it('the same recovery after a restart while pending: the pending key is reused (resume), not a new key', async () => {
		const store = memStore()
		const keys: string[] = []
		const incomplete = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_incomplete' } })
		await startCleanupAfterRecovery(store, A, () => 'K-ONE', (c) => { keys.push(c.idempotencyKey); return incomplete() })
		resetCleanupGuardsForTest()
		const out = await startCleanupAfterRecovery(store, A, () => 'K-TWO', (c) => { keys.push(c.idempotencyKey); return okSend() })
		expect(out).toEqual({ kind: 'ok' })
		// clear_incomplete resumes inside the run with the same key (several sends are allowed); no send ever uses a second key
		expect(keys.length).toBeGreaterThan(1)
		expect(keys.every((k) => k === 'K-ONE')).toBe(true)
	})

	it('a concurrent repeat while the first is in flight → no second send', async () => {
		const store = memStore()
		const sent: string[] = []
		let release: (v: { kind: string; payload?: Record<string, unknown> }) => void = () => undefined
		const slow = (c: { accountKey: string }) => { sent.push(c.accountKey); return new Promise<{ kind: string; payload?: Record<string, unknown> }>((resolve) => { release = (v) => resolve(v) }) }
		const first = cleanupAfterVerifiedRecovery(store, A, pageRead(A), slow)
		await Promise.resolve()
		const second = await cleanupAfterVerifiedRecovery(store, A, pageRead(A), slow)
		expect(second).toBeNull()
		release({ kind: 'payload', payload: { type: 'ack', ok: true } })
		await first
		expect(sent).toEqual([A])
	})
})
