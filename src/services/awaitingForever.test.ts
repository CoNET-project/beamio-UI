/**
 * @jest-environment node
 */
// an item that never gets a receipt is shown truthfully as waiting, with a retry entry; the controlled reload stays suspended; a timeout never clears the queue and never
// shows success.
import { readFileSync } from 'fs'
import { join } from 'path'
import { base64JsonCodec } from './chatDraftStore'
import { chatWriteLockState, requestControlledReload, requestUserReload, resetChatWriteLockForTest, setQueueHold } from './chatWriteLock'
import { createQueueStore, createSendQueue, type QueueDocAdapter, type QueueItem, type QueueState } from './sendQueue'

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const HOUR = 3600_000

function disk() {
	const docs = new Map<string, string>()
	const adapter: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: async (id, t) => { docs.set(id, t) },
		remove: async (id) => { docs.delete(id) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)),
	}
	return { docs, adapter }
}
const item = (sendId: string): QueueItem => ({ v: 1, sendId, peer: PEER, text: 'x', createdAt: 1, queuedAt: 1 })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

beforeEach(() => { jest.useFakeTimers('modern'); jest.setSystemTime(new Date('2026-11-27T12:00:00Z')); resetChatWriteLockForTest() })
afterEach(() => { resetChatWriteLockForTest(); jest.useRealTimers() })

describe('an item that never gets a receipt', () => {
	async function foreverQueue() {
		const d = disk()
		const states: Array<QueueState | 'removed'> = []
		let attempts = 0
		const q = createSendQueue({
			store: createQueueStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec() }),
			peer: PEER,
			isOnline: () => true,
			isVisible: () => true,
			resume: async () => { attempts += 1; return { kind: 'awaiting', persisted: true } }, // the entry answers an empty 200, no receipt ever comes
			persistConfirmed: async () => true,
			onHold: (h) => setQueueHold('acct:peer', h),
			onState: (_id, st) => states.push(st),
		})
		await q.enqueue(item('s1'))
		await q.run('s1', async () => ({ kind: 'awaiting', persisted: true }))
		await flush()
		return { q, d, states, attempts: () => attempts }
	}

	it('stays in the queue and on disk, as `awaiting`, for 48 hours of heartbeats: no timeout clears it, it is never reported removed or sent', async () => {
		const { q, d, states } = await foreverQueue()
		for (let h = 0; h < 48; h++) { jest.advanceTimersByTime(HOUR); await flush() }
		expect(q.has('s1')).toBe(true)
		expect(q.stateOf('s1')).toBe('awaiting')
		expect(d.docs.size).toBe(1)
		expect(states).not.toContain('removed')
		expect(states).not.toContain('confirmed')
		q.dispose()
	})

	it('keeps trying at the slow pace (it does not go quiet and does not hammer): some attempts in 48 hours, far fewer than one per heartbeat', async () => {
		const { q, attempts } = await foreverQueue()
		const before = attempts()
		for (let step = 0; step < 48 * 120; step++) { jest.advanceTimersByTime(30_000); await flush() } // 30 s steps: the heartbeat's own pace
		const made = attempts() - before
		expect(made).toBeGreaterThan(48 * 5) // about one per 10 minutes at the end of the ladder
		expect(made).toBeLessThan(48 * 120 / 4) // far fewer than one per heartbeat (that would be 5760)
		q.dispose()
	})

	it('the retry entry: a manual kick starts an attempt at once even inside the slow pace, and the item stays the same sendId and the same document', async () => {
		const { q, d, attempts } = await foreverQueue()
		for (let m = 0; m < 30; m++) { jest.advanceTimersByTime(60_000); await flush() }
		const before = attempts()
		const doc = [...d.docs.entries()]
		q.kick('manual')
		await flush()
		expect(attempts()).toBe(before + 1)
		expect([...d.docs.entries()]).toEqual(doc)
		expect(q.stateOf('s1')).toBe('awaiting')
		q.dispose()
	})

	it('the controlled reload stays suspended however long it waits, and the tap override is gone', async () => {
		const { q } = await foreverQueue()
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		for (let h = 0; h < 48; h++) { jest.advanceTimersByTime(HOUR); await flush() }
		expect(reload).not.toHaveBeenCalled()
		expect(requestUserReload(reload)).toBe(true)
		expect(chatWriteLockState()).toMatchObject({ awaiting: 1, heldReload: true })
		q.dispose()
	})
})

describe('the bubble shows the wait and the retry entry (chat.tsx, static)', () => {
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('an awaiting bubble says "awaiting confirmation" (never "Sent" or "Delivered") and has a Retry button that kicks the queue manually', () => {
		expect(chat).toMatch(/\{m\.status === "sent" && <span className="text-slate-400">\{m\.sendId && awaitingSendIds\.has\(m\.sendId\) \? tu\('chat\.status\.awaiting_ack'\) : 'Sent'\}<\/span>\}/)
		expect(chat).toMatch(/\{m\.status === "sent" && m\.sendId && awaitingSendIds\.has\(m\.sendId\) && \(\s*<button\s+type="button"\s+data-testid="awaiting-retry"\s+onClick=\{\(\) => sendQueueRef\.current\?\.kick\('manual'\)\}/)
		expect(chat).toMatch(/tu\('chat\.held\.action\.retry'\)/)
	})
	it('nothing in the queue removes an awaiting item by time (when the queue removes a document is checked by behaviour in sendQueueRemoval.test.ts)', () => {
		const q = readFileSync(join(__dirname, 'sendQueue.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(q).not.toMatch(/awaitingSince[^;\n]*>=[^;\n]*(drop|remove|splice|delete)/)
	})
})
