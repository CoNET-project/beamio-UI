/**
 * @jest-environment node
 */
// while the send queue is not empty the app's controllable reload stays suspended. NOTHING lets it through: not the 4 minute mark, not the 30 second tap-again.
// The two marks (reloadHoldPolicy.ts) only choose what the status shows. Every test below fails for an implementation that releases a held reload by time or by a second tap.
import { AWAITING_LONG_AFTER_MS, AWAITING_NOTICE_AFTER_MS, awaitingStatusOf } from './reloadHoldPolicy'
import { beginChatWrite, chatWriteLockState, noteDraftDirty, noteDraftSaved, noteMessageSaved, noteMessageSaving, noteRequestInFlight, noteRequestSettled, onUserReloadHeld, reloadHoldAwaitingStatus, reloadHoldSoftKind, requestControlledReload, requestUserReload, resetChatWriteLockForTest, setQueueHold, type ReloadHoldReason } from './chatWriteLock'
import { createQueueStore, createSendQueue, type AttemptResult, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { base64JsonCodec } from './chatDraftStore'
import * as fs from 'fs'
import * as path from 'path'

const MIN = 60 * 1000
const SEC = 1000
const awaitingOnly = (since: number, n = 1) => setQueueHold('acct:peer', { firm: 0, awaiting: n, awaitingSince: since })

beforeEach(() => {
	jest.useFakeTimers('modern')
	jest.setSystemTime(new Date('2026-11-27T12:00:00Z'))
	resetChatWriteLockForTest()
})
afterEach(() => {
	resetChatWriteLockForTest()
	jest.useRealTimers()
})

describe('the lock itself has no timer and nothing else releases a reload by time', () => {
	it('chatWriteLock.ts has no setTimeout/setInterval and no scheduler; the expiry module is gone and nothing installs it; the policy file no longer has a hold limit or an override', () => {
		const lock = fs.readFileSync(path.join(__dirname, 'chatWriteLock.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
		expect(lock).not.toMatch(/setTimeout|setInterval|setHoldExpiryScheduler|reevaluateHolds|rescheduleExpiry|AWAITING_HOLD_MAX_MS|USER_OVERRIDE_AFTER_MS|onlyAwaitingHolds/)
		expect(fs.existsSync(path.join(__dirname, 'reloadHoldExpiry.ts'))).toBe(false)
		const index = fs.readFileSync(path.join(__dirname, '../index.tsx'), 'utf8')
		expect(index).not.toMatch(/reloadHoldExpiry|installReloadHoldExpiry/)
		const policy = fs.readFileSync(path.join(__dirname, 'reloadHoldPolicy.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(policy).not.toMatch(/HOLD_MAX|OVERRIDE|release|setTimeout/)
	})
	it('the queue-blocks rule has no age in it', () => {
		const lock = fs.readFileSync(path.join(__dirname, 'chatWriteLock.ts'), 'utf8')
		expect(lock).toMatch(/const queueBlocks = \(\): boolean => firmTotal\(\) > 0 \|\| awaitingTotal\(\) > 0/)
	})
})

describe('the marks only choose what the status shows', () => {
	it('30 seconds and 4 minutes, from the first wait; none when nothing awaits', () => {
		expect(AWAITING_NOTICE_AFTER_MS).toBe(30 * SEC)
		expect(AWAITING_LONG_AFTER_MS).toBe(4 * MIN)
		expect(awaitingStatusOf(null, 99)).toBe('none')
		expect(awaitingStatusOf(0, 29 * SEC)).toBe('waiting')
		expect(awaitingStatusOf(0, 30 * SEC)).toBe('still_waiting')
		expect(awaitingStatusOf(0, 4 * MIN - 1)).toBe('still_waiting')
		expect(awaitingStatusOf(0, 4 * MIN)).toBe('long_wait')
	})
	it('the lock reports the status of the OLDEST awaiting item and "none" when the queue holds only firm items or is empty', () => {
		expect(reloadHoldAwaitingStatus()).toBe('none')
		awaitingOnly(Date.now() - 20 * SEC)
		expect(reloadHoldAwaitingStatus()).toBe('waiting')
		awaitingOnly(Date.now() - 40 * SEC)
		expect(reloadHoldAwaitingStatus()).toBe('still_waiting')
		awaitingOnly(Date.now() - 5 * MIN)
		expect(reloadHoldAwaitingStatus()).toBe('long_wait')
		setQueueHold('acct:peer', { firm: 1, awaiting: 0, awaitingSince: null })
		expect(reloadHoldAwaitingStatus()).toBe('none')
	})
})

describe('behaviour table: an app-requested reload', () => {
	it('queue EMPTY: runs at once', () => {
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(false)
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('queue NOT empty, within 30 seconds: held', () => {
		awaitingOnly(Date.now())
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		jest.advanceTimersByTime(29 * SEC)
		expect(reload).not.toHaveBeenCalled()
	})
	it('queue NOT empty, past 30 seconds, past 4 minutes, past an hour: STILL held (no timer releases it)', () => {
		awaitingOnly(Date.now())
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		for (const ms of [31 * SEC, 4 * MIN, 5 * MIN, 60 * MIN]) {
			jest.advanceTimersByTime(ms)
			expect(reloadHoldAwaitingStatus()).not.toBe('none') // asking for the status (what the toast does) releases nothing either
			expect(reload).not.toHaveBeenCalled()
		}
		expect(chatWriteLockState().awaiting).toBe(1)
		expect(requestControlledReload(jest.fn())).toBe(true) // and a new request is held too
	})
	it('an item that has been awaiting for 4+ minutes when the request is made is held as well (the age of the item never matters)', () => {
		awaitingOnly(Date.now() - 30 * MIN)
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		jest.advanceTimersByTime(30 * MIN)
		expect(reload).not.toHaveBeenCalled()
	})
	it('the reload runs once, at once, when the LAST item leaves (proof arrived and the copy is safe)', () => {
		awaitingOnly(Date.now(), 2)
		const reload = jest.fn()
		requestControlledReload(reload)
		jest.advanceTimersByTime(10 * MIN)
		setQueueHold('acct:peer', { firm: 0, awaiting: 1, awaitingSince: Date.now() })
		expect(reload).not.toHaveBeenCalled()
		setQueueHold('acct:peer', { firm: 0, awaiting: 0, awaitingSince: null })
		expect(reload).toHaveBeenCalledTimes(1)
		jest.advanceTimersByTime(10 * MIN)
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('a non-awaiting item (queued, failed, held) holds as long as it is there', () => {
		setQueueHold('acct:peer', { firm: 1, awaiting: 0, awaitingSince: null })
		const reload = jest.fn()
		requestControlledReload(reload)
		jest.advanceTimersByTime(60 * MIN)
		expect(reload).not.toHaveBeenCalled()
		expect(requestUserReload(jest.fn())).toBe(true)
	})
})

describe('the user\'s own tap never overrides (it used to, after 30 seconds)', () => {
	it('before 30 seconds, at 30 seconds, after 4 minutes, after an hour: held every time, the listener hears "awaiting", the reload is never issued, the second tap does nothing more than the first', () => {
		awaitingOnly(Date.now())
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		const reload = jest.fn()
		let taps = 0
		for (const ms of [29 * SEC, 2 * SEC, 4 * MIN, 60 * MIN]) {
			jest.advanceTimersByTime(ms)
			expect(requestUserReload(reload)).toBe(true)
			taps += 1
			expect(reload).not.toHaveBeenCalled()
		}
		expect(heard).toEqual(Array(taps).fill('awaiting'))
	})
	it('a CONFIRMED-style soft hold (reported as awaiting) is not overridable either', () => {
		awaitingOnly(Date.now() - 10 * MIN)
		const reload = jest.fn()
		for (let i = 0; i < 5; i++) expect(requestUserReload(reload)).toBe(true)
		expect(reload).not.toHaveBeenCalled()
	})
	it('what else holds stays held, and releases exactly as before (write, unsaved, draft, in flight)', () => {
		const cases: Array<{ on: () => () => void }> = [
			{ on: () => { noteMessageSaving('m1'); return () => noteMessageSaved('m1') } },
			{ on: () => { const end = beginChatWrite(); return () => end() } },
			{ on: () => { noteDraftDirty('p'); return () => noteDraftSaved('p') } },
			{ on: () => { noteRequestInFlight('r'); return () => noteRequestSettled('r') } },
		]
		for (const c of cases) {
			resetChatWriteLockForTest()
			const release = c.on()
			const reload = jest.fn()
			expect(requestControlledReload(reload)).toBe(true)
			jest.advanceTimersByTime(10 * MIN)
			expect(reload).not.toHaveBeenCalled()
			release()
			expect(reload).toHaveBeenCalledTimes(1)
		}
	})
	it('the awaiting count is in the QA state', () => {
		awaitingOnly(Date.now() - 10 * MIN)
		expect(chatWriteLockState()).toMatchObject({ queued: 1, awaiting: 1 })
	})
})

describe('the held toast follows the status and carries no way through', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const notice = require('./reloadHeldNotice') as typeof import('./reloadHeldNotice')
	it('awaiting copy by status: waiting, still_waiting (30 s), long_wait (4 min); every other reason is unchanged', () => {
		expect(notice.reloadHeldCopyKey('awaiting', 'waiting')).toBe('chat.reload.held_awaiting')
		expect(notice.reloadHeldCopyKey('awaiting')).toBe('chat.reload.held_awaiting')
		expect(notice.reloadHeldCopyKey('awaiting', 'still_waiting')).toBe('chat.reload.held_awaiting_30s')
		expect(notice.reloadHeldCopyKey('awaiting', 'long_wait')).toBe('chat.reload.held_awaiting_long')
		expect(notice.reloadHeldCopyKey('queue', 'long_wait')).toBe('chat.reload.held_failed')
		expect(notice.reloadHeldCopyKey('writing', 'long_wait')).toBe('chat.reload.held_saving')
	})
	it('the copy exists in both locale files and promises no automatic refresh by time and no tap-again', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const en = (require('../locale/en.json') as { ui: Record<string, string> }).ui
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const zh = (require('../locale/zh-CN.json') as { ui: Record<string, string> }).ui
		for (const k of ['chat.reload.held_awaiting', 'chat.reload.held_awaiting_30s', 'chat.reload.held_awaiting_long']) {
			expect(en[k]).toBeTruthy()
			expect(zh[k]).toBeTruthy()
			expect(en[k]).not.toMatch(/again|within a few minutes|refreshes by itself/i)
			expect(zh[k]).not.toMatch(/再次点按|几分钟内自动刷新/)
		}
	})
	it('the notice reads the status when the tap is held', () => {
		const src = fs.readFileSync(path.join(__dirname, 'reloadHeldNotice.ts'), 'utf8')
		expect(src).toMatch(/showBeamioToast\(tu\(reloadHeldCopyKey\(reason, reloadHoldAwaitingStatus\(\), reloadHoldSoftKind\(\), reloadHoldFirmStatus\(\)\), \{ count: reloadHoldView\(\)\.count \}\)\)/)
	})
})

describe('the queue reports firm / awaiting / since', () => {
	function memoryDisk() {
		const docs = new Map<string, string>()
		const adapter: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
		return adapter
	}
	const item = (sendId: string): QueueItem => ({ v: 1, sendId, peer: '0xcccc000000000000000000000000000000000003', text: sendId, createdAt: 1, queuedAt: 1 })

	it('an item that goes awaiting starts the clock; a re-POST that ends awaiting again does not restart it; leaving awaiting clears it', async () => {
		let now = 1_000
		const holds: Array<{ firm: number; awaiting: number; awaitingSince: number | null; confirmed: number }> = []
		const results: AttemptResult[] = [{ kind: 'awaiting', persisted: true }, { kind: 'awaiting', persisted: true }, { kind: 'failed' }, { kind: 'sent', persisted: true }]
		const q = createSendQueue({
			store: createQueueStore({ eoa: '0xaaaa000000000000000000000000000000000001', doc: memoryDisk(), codec: base64JsonCodec() }),
			peer: '0xcccc000000000000000000000000000000000003',
			resume: async () => results.shift() as AttemptResult,
			persistConfirmed: async () => true,
			now: () => now,
			onHold: (h) => holds.push(h),
		})
		await q.enqueue(item('s1'))
		const last = () => holds[holds.length - 1]
		await q.run('s1', async () => results.shift() as AttemptResult) // awaiting
		expect(last()).toMatchObject({ firm: 0, awaiting: 1, awaitingSince: 1_000, confirmed: 0, firmSince: null })
		now = 90_000
		await q.run('s1', async () => results.shift() as AttemptResult) // awaiting again: the clock keeps its first moment
		expect(last()).toMatchObject({ firm: 0, awaiting: 1, awaitingSince: 1_000, confirmed: 0, firmSince: null })
		await q.run('s1', async () => results.shift() as AttemptResult) // failed: not awaiting any more
		expect(last()).toMatchObject({ firm: 1, awaiting: 0, awaitingSince: null, confirmed: 0 })
		expect(typeof last().firmSince).toBe('number') // the clock of a failed item: from the moment it entered the firm states
		await q.run('s1', async () => results.shift() as AttemptResult) // sent with proof: gone
		expect(last()).toMatchObject({ firm: 0, awaiting: 0, awaitingSince: null, confirmed: 0, firmSince: null })
	})
})

describe('a CONFIRMED item (receipt seen, copy not durable) holds a reload like any other item: no cap, no override', () => {
	function memoryDisk() {
		const docs = new Map<string, string>()
		const adapter: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
		return adapter
	}
	const PEER = '0xcccc000000000000000000000000000000000003'
	const EOA = '0xaaaa000000000000000000000000000000000001'
	const flushAll = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
	async function confirmedQueue() {
		const q = createSendQueue({
			store: createQueueStore({ eoa: EOA, doc: memoryDisk(), codec: base64JsonCodec() }),
			peer: PEER,
			resume: async () => ({ kind: 'sent', persisted: false }), // proof seen, the copy is not durable (library append never ACKs)
			persistConfirmed: async () => false,
			onHold: (h) => setQueueHold('acct:peer', h),
			heartbeatMs: 0,
		})
		await q.enqueue({ v: 1, sendId: 'cf1', peer: PEER, text: 'x', createdAt: 1, queuedAt: 1 })
		await q.run('cf1', async () => ({ kind: 'sent', persisted: false }))
		await flushAll()
		expect(q.stateOf('cf1')).toBe('confirmed')
		return q
	}

	it('the app reload stays held past 4 minutes and past an hour', async () => {
		const q = await confirmedQueue()
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		for (const ms of [4 * MIN + 1000, 60 * MIN]) {
			jest.advanceTimersByTime(ms)
			expect(reload).not.toHaveBeenCalled()
		}
		q.dispose()
	})

	it('the user\'s tap does not override after 30 seconds or later', async () => {
		const q = await confirmedQueue()
		const reload = jest.fn()
		for (const ms of [20 * SEC, 11 * SEC, 10 * MIN]) {
			jest.advanceTimersByTime(ms)
			expect(requestUserReload(reload)).toBe(true)
		}
		expect(reload).not.toHaveBeenCalled()
		q.dispose()
	})

	it('the queue reports a confirmed item as awaiting (soft), with the clock of its first moment (the clock only feeds the status)', async () => {
		const holds: Array<{ firm: number; awaiting: number; awaitingSince: number | null; confirmed: number }> = []
		const q = createSendQueue({
			store: createQueueStore({ eoa: EOA, doc: memoryDisk(), codec: base64JsonCodec() }),
			peer: PEER, resume: async () => ({ kind: 'sent', persisted: false }), persistConfirmed: async () => false, now: () => 5_000, onHold: (h) => holds.push(h), heartbeatMs: 0,
		})
		await q.enqueue({ v: 1, sendId: 'cf2', peer: PEER, text: 'x', createdAt: 1, queuedAt: 1 })
		await q.run('cf2', async () => ({ kind: 'sent', persisted: false }))
		expect(holds[holds.length - 1]).toMatchObject({ firm: 0, awaiting: 1, awaitingSince: 5_000, confirmed: 1, firmSince: null })
		q.dispose()
	})
})

describe('display: the two kinds of soft item are told apart; the hold is the same', () => {
	const MIN = 60_000
	it('reloadHoldSoftKind: awaiting when any soft item still waits for proof, confirmed when every soft item is confirmed, none without soft items', () => {
		expect(reloadHoldSoftKind()).toBe('none')
		setQueueHold('acct:peer', { firm: 0, awaiting: 2, awaitingSince: Date.now(), confirmed: 2 })
		expect(reloadHoldSoftKind()).toBe('confirmed')
		setQueueHold('acct:peer', { firm: 0, awaiting: 2, awaitingSince: Date.now(), confirmed: 1 })
		expect(reloadHoldSoftKind()).toBe('awaiting')
		setQueueHold('acct:peer', { firm: 0, awaiting: 1, awaitingSince: Date.now() }) // the older form without the count: awaiting
		expect(reloadHoldSoftKind()).toBe('awaiting')
		setQueueHold('other:peer', { firm: 0, awaiting: 1, awaitingSince: Date.now(), confirmed: 1 })
		setQueueHold('acct:peer', { firm: 1, awaiting: 0, awaitingSince: null })
		expect(reloadHoldSoftKind()).toBe('confirmed') // another conversation's confirmed item
	})
	it('the toast copy: confirmed-only gives the backup line (never "awaiting confirmation"), awaiting keeps its three-step copy; the other reasons are unchanged', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const notice = require('./reloadHeldNotice') as typeof import('./reloadHeldNotice')
		expect(notice.reloadHeldCopyKey('awaiting', 'long_wait', 'confirmed')).toBe('chat.reload.held_backup')
		expect(notice.reloadHeldCopyKey('awaiting', 'waiting', 'confirmed')).toBe('chat.reload.held_backup')
		expect(notice.reloadHeldCopyKey('awaiting', 'waiting', 'awaiting')).toBe('chat.reload.held_awaiting')
		expect(notice.reloadHeldCopyKey('awaiting', 'still_waiting', 'awaiting')).toBe('chat.reload.held_awaiting_30s')
		expect(notice.reloadHeldCopyKey('queue', 'waiting', 'confirmed')).toBe('chat.reload.held_failed')
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const en = (require('../locale/en.json') as { ui: Record<string, string> }).ui
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const zh = (require('../locale/zh-CN.json') as { ui: Record<string, string> }).ui
		expect(zh['chat.reload.held_backup']).toContain('本地备份仍在重试')
		expect(en['chat.reload.held_backup']).toContain('Local backup is still retrying')
		expect(zh['chat.reload.held_backup']).not.toContain('等待确认')
		expect(en['chat.reload.held_backup']).not.toMatch(/awaiting confirmation|waiting for confirmation/i)
	})
	it('the hold itself does not change with the kind: a confirmed-only queue holds the reload past 4 minutes and an hour, exactly like an awaiting one', () => {
		setQueueHold('acct:peer', { firm: 0, awaiting: 1, awaitingSince: Date.now() - 10 * MIN, confirmed: 1 })
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		jest.advanceTimersByTime(60 * MIN)
		expect(reload).not.toHaveBeenCalled()
		expect(requestUserReload(reload)).toBe(true)
	})
	it('the bubble: a confirmed item is not in the awaiting set (chat.tsx fills it from the queue state `awaiting` only), so its bubble never says "awaiting confirmation"', () => {
		const chat = fs.readFileSync(path.join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/if \(state === 'awaiting'\) next\.add\(sendId\)\s*else next\.delete\(sendId\)/)
	})
})
