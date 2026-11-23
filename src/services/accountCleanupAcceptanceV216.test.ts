/**
 * The PWA-drivable items of the three-platform acceptance draft (v216 §236, S-01..S-14; the draft lives in the spec folder, SHA256 67cea539…1190 — not copied into the repository). Items that only the native side or the device can show (S-08 wallet kept, S-09 chat kept, S-10/S-11/S-14 unattributed and
 * owner/inbox/signals kept, S-13 active account group kept) are device items; the PWA part of each is noted per case. Behaviour-level:
 * a fake store, a fake page read and a fake native send. No UI, no pick, no notice.
 */
import { CLEANUP_DONE_KEY, CLEANUP_PENDING_KEY, cleanupAfterVerifiedRecovery, resetCleanupGuardsForTest, startCleanupAfterRecovery } from './accountCleanupPending'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
type Cmd = { type: string; reqId: number; accountKey: string; idempotencyKey: string }

function memStore() {
	const m = new Map<string, string>()
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		keys: () => [...m.keys()],
		has: (k: string) => m.has(k),
		put: (k: string, v: string) => void m.set(k, v),
	}
}
const ok = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: true, result: { cleanupPending: false, keptUnattributed: 0 } } })
const notReady = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_ready', result: { cleanupPending: false, keptUnattributed: 0 } } })
const incomplete = () => Promise.resolve({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'clear_incomplete', result: { cleanupPending: true, keptUnattributed: 0 } } })
const pageRead = (addr: unknown) => () => Promise.resolve(addr)
let seq = 0
const newKey = () => `ACC-${++seq}`

beforeEach(() => resetCleanupGuardsForTest())

describe('S-01 successful recovery with an agreeing read-back: silent cleanup, the command carries only the two fields', () => {
	it('the page sends the command once on its own, with accountKey and idempotencyKey only', async () => {
		const store = memStore()
		const sent: Cmd[] = []
		const out = await cleanupAfterVerifiedRecovery(store, A, pageRead(A), (c) => { sent.push(c as unknown as Cmd); return ok() })
		expect(out).toEqual({ kind: 'ok' })
		expect(sent).toHaveLength(1)
		expect(Object.keys(sent[0]).sort()).toEqual(['accountKey', 'idempotencyKey', 'reqId', 'type'])
		expect(sent[0].accountKey).toBe(A)
		expect(typeof sent[0].idempotencyKey).toBe('string')
	})
	it('the pending marker is cleared and the done record is kept', async () => {
		const store = memStore()
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), () => ok())
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(true)
	})
	it('the PWA writes only its own cleanup keys: the new account record and any other key are untouched (S-08, S-09 PWA part)', async () => {
		const store = memStore()
		store.put('wallet.v1.new', '{"eoa":"new"}')
		store.put('chat.v1.session', '{"records":3}')
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), () => ok())
		expect(store.keys().filter((k) => !k.startsWith('beamio.accountCleanupOld.'))).toEqual(['wallet.v1.new', 'chat.v1.session'])
		expect(store.getItem('wallet.v1.new')).toBe('{"eoa":"new"}')
		expect(store.getItem('chat.v1.session')).toBe('{"records":3}')
	})
})

describe('S-02 recovery failed: no command', () => {
	it('a failed native recovery (no native address) sends nothing', async () => {
		const store = memStore()
		let sent = 0
		const out = await cleanupAfterVerifiedRecovery(store, null, pageRead(A), () => { sent++; return ok() })
		expect(out).toBeNull()
		expect(sent).toBe(0)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})
})

describe('S-03 recovery completed but no confirmation (the page cannot read its derived address): no command', () => {
	it('an unreadable page read sends nothing and reports no success', async () => {
		const store = memStore()
		let sent = 0
		const out = await cleanupAfterVerifiedRecovery(store, A, () => Promise.reject(new Error('no read')), () => { sent++; return ok() })
		expect(out).toBeNull()
		expect(sent).toBe(0)
	})
})

describe('S-04 read-back failure: no command, no success reported', () => {
	it('a page address that cannot be read sends nothing (the answer would be not_ready; the PWA sends nothing)', async () => {
		const store = memStore()
		let sent = 0
		const out = await cleanupAfterVerifiedRecovery(store, A, pageRead(null), () => { sent++; return notReady() })
		expect(out).toBeNull()
		expect(sent).toBe(0)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
	})
})

describe('S-05 address mismatch: no command, no confirmation recorded', () => {
	it('the page address differs from the native address: nothing is sent and nothing is recorded', async () => {
		const store = memStore()
		let sent = 0
		const out = await cleanupAfterVerifiedRecovery(store, B, pageRead(A), () => { sent++; return ok() })
		expect(out).toBeNull()
		expect(sent).toBe(0)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})
})

describe('S-06 repeat callback after a completed cleanup: no second deletion', () => {
	it('the same recovery repeated (in the page or after a restart) sends nothing more', async () => {
		const store = memStore()
		const sent: string[] = []
		const send = (c: unknown) => { sent.push((c as Cmd).idempotencyKey); return ok() }
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		resetCleanupGuardsForTest()
		await cleanupAfterVerifiedRecovery(store, A, pageRead(A), send)
		expect(sent).toHaveLength(1)
	})
})

describe('S-07 interrupted cleanup, restart: resumes with the same key until ok', () => {
	it('an incomplete run keeps the pending marker; the restart resumes with the same idempotencyKey and reaches ok', async () => {
		const store = memStore()
		const keys: string[] = []
		await startCleanupAfterRecovery(store, A, newKey, (c) => { keys.push((c as Cmd).idempotencyKey); return incomplete() })
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		resetCleanupGuardsForTest()
		const out = await startCleanupAfterRecovery(store, A, newKey, (c) => { keys.push((c as Cmd).idempotencyKey); return ok() })
		expect(out).toEqual({ kind: 'ok' })
		expect(new Set(keys).size).toBe(1)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(false)
	})
	it('clear_incomplete on every attempt is at most three attempts and keeps the marker (never a success)', async () => {
		const store = memStore()
		let attempts = 0
		const out = await startCleanupAfterRecovery(store, A, newKey, () => { attempts++; return incomplete() })
		expect(out).toEqual({ kind: 'incomplete' })
		expect(attempts).toBe(3)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
	})
})

describe('S-12 gate locked (not_ready): no deletion, not clear_incomplete', () => {
	it('a not_ready answer keeps the pending marker, reports no success and deletes nothing', async () => {
		const store = memStore()
		let attempts = 0
		const out = await startCleanupAfterRecovery(store, A, newKey, () => { attempts++; return notReady() })
		expect(out.kind).toBe('refused')
		expect(attempts).toBe(1)
		expect(store.has(CLEANUP_PENDING_KEY)).toBe(true)
		expect(store.has(CLEANUP_DONE_KEY)).toBe(false)
	})
})
