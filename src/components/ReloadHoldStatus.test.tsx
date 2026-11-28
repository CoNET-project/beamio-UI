/**
 * the standing status while a reload is held, whoever asked for it, with tiers for FAILED (firm) items and the count. The hold rule is unchanged.
 */
import { act, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import ReloadHoldStatus from './ReloadHoldStatus'
import { onReloadHoldChange, reloadHoldFirmStatus, reloadHoldView, requestControlledReload, requestUserReload, resetChatWriteLockForTest, setQueueHold } from '../services/chatWriteLock'
import { reloadHeldCopyKey, reloadHoldStatusOf } from '../services/reloadHeldNotice'
import { createQueueStore, createSendQueue, type QueueDocAdapter, type QueueItem } from '../services/sendQueue'
import { base64JsonCodec } from '../services/chatDraftStore'
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util'

// the document codec needs TextEncoder / TextDecoder, which the jsdom environment does not provide
if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
	;(globalThis as unknown as { TextEncoder: unknown; TextDecoder: unknown }).TextEncoder = NodeTextEncoder
	;(globalThis as unknown as { TextEncoder: unknown; TextDecoder: unknown }).TextDecoder = NodeTextDecoder
}

const SEC = 1000
const MIN = 60 * SEC
const failedHold = (since: number, n = 1) => setQueueHold('acct:peer', { firm: n, awaiting: 0, awaitingSince: null, confirmed: 0, firmSince: since })

beforeEach(() => { jest.useFakeTimers('modern'); jest.setSystemTime(new Date('2026-11-28T06:00:00Z')); resetChatWriteLockForTest() })
afterEach(() => { resetChatWriteLockForTest(); jest.useRealTimers() })

describe('the tiers of a failed (firm) item', () => {
	it('reloadHoldFirmStatus runs on the earliest firm moment: waiting, still_waiting at 30 s, long_wait at 4 min; none without firm items', () => {
		expect(reloadHoldFirmStatus()).toBe('none')
		failedHold(Date.now())
		expect(reloadHoldFirmStatus()).toBe('waiting')
		jest.advanceTimersByTime(30 * SEC)
		expect(reloadHoldFirmStatus()).toBe('still_waiting')
		jest.advanceTimersByTime(4 * MIN)
		expect(reloadHoldFirmStatus()).toBe('long_wait')
		setQueueHold('acct:peer', { firm: 1, awaiting: 0, awaitingSince: null }) // the queue did not say when: no tier, never a guess
		expect(reloadHoldFirmStatus()).toBe('none')
	})
	it('the copy key by tier for the queue reason, and the other reasons are unchanged', () => {
		expect(reloadHeldCopyKey('queue', 'none', 'none', 'waiting')).toBe('chat.reload.held_failed')
		expect(reloadHeldCopyKey('queue', 'none', 'none', 'still_waiting')).toBe('chat.reload.held_failed_30s')
		expect(reloadHeldCopyKey('queue', 'none', 'none', 'long_wait')).toBe('chat.reload.held_failed_long')
		expect(reloadHeldCopyKey('awaiting', 'still_waiting', 'awaiting', 'long_wait')).toBe('chat.reload.held_awaiting_30s')
		expect(reloadHeldCopyKey('unsaved')).toBe('chat.reload.held_unsaved')
	})
})

describe('an APPLICATION-requested reload that is held is shown, without any key press', () => {
	it('the view: held, why, and how many items cause it; the listeners hear it when it is held and when it ends', () => {
		failedHold(Date.now(), 2)
		const heard: boolean[] = []
		onReloadHoldChange(() => heard.push(reloadHoldView().held))
		expect(reloadHoldView().held).toBe(false) // nothing asked for a reload yet
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(true)
		expect(reloadHoldView()).toMatchObject({ held: true, reason: 'queue', count: 2 })
		expect(heard).toContain(true)
		setQueueHold('acct:peer', { firm: 0, awaiting: 0, awaitingSince: null })
		expect(reload).toHaveBeenCalledTimes(1)
		expect(heard[heard.length - 1]).toBe(false)
	})
	it('reloadHoldStatusOf: the key and the count; nothing when not held; the confirmed-only hold says backup, not failed', () => {
		expect(reloadHoldStatusOf(reloadHoldView())).toBeNull()
		failedHold(Date.now() - 31 * SEC, 3)
		requestControlledReload(jest.fn())
		expect(reloadHoldStatusOf(reloadHoldView())).toEqual({ key: 'chat.reload.held_failed_30s', count: 3 })
		resetChatWriteLockForTest()
		setQueueHold('acct:peer', { firm: 0, awaiting: 1, awaitingSince: Date.now() - 10 * MIN, confirmed: 1, firmSince: null })
		requestControlledReload(jest.fn())
		expect(reloadHoldStatusOf(reloadHoldView())).toEqual({ key: 'chat.reload.held_backup', count: 1 })
	})
	it('the standing line on screen: hidden when nothing is held; at once when an application reload is held; the tier changes with time; gone when the queue empties; it never lets the reload through', () => {
		render(<ReloadHoldStatus />)
		expect(screen.queryByTestId('reload-hold-status')).toBeNull()
		failedHold(Date.now(), 2)
		const reload = jest.fn()
		act(() => { requestControlledReload(reload) })
		expect(screen.getByTestId('reload-hold-status').getAttribute('data-key')).toBe('chat.reload.held_failed')
		expect(screen.getByTestId('reload-hold-status').textContent).toContain('2')
		act(() => { jest.advanceTimersByTime(31 * SEC) })
		expect(screen.getByTestId('reload-hold-status').getAttribute('data-key')).toBe('chat.reload.held_failed_30s')
		act(() => { jest.advanceTimersByTime(10 * MIN) })
		expect(screen.getByTestId('reload-hold-status').getAttribute('data-key')).toBe('chat.reload.held_failed_long')
		expect(reload).not.toHaveBeenCalled()
		expect(requestUserReload(reload)).toBe(true) // the tap is not an override either (same key: it replaces the held reload, which is still the one that runs once at the end)
		act(() => { setQueueHold('acct:peer', { firm: 0, awaiting: 0, awaitingSince: null }) })
		expect(reload).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId('reload-hold-status')).toBeNull()
	})
	it('the copy: three failed tiers, in both locale files, with the count, the retry hint, and no promise of an automatic refresh by time', () => {
		for (const f of ['en', 'zh-CN']) {
			const ui = (JSON.parse(readFileSync(join(__dirname, `../locale/${f}.json`), 'utf8')) as { ui: Record<string, string> }).ui
			for (const k of ['chat.reload.held_failed', 'chat.reload.held_failed_30s', 'chat.reload.held_failed_long']) {
				expect(ui[k]).toContain('{{count}}')
				expect(ui[k]).toContain('Failed · Tap to retry')
				expect(ui[k]).not.toMatch(/within a few minutes|refreshes by itself|几分钟内自动刷新|再次点按刷新/)
			}
		}
	})
	it('index.tsx mounts the line in production code (it is not behind the hook switch)', () => {
		const index = readFileSync(join(__dirname, '../index.tsx'), 'utf8')
		expect(index).toMatch(/<App \/>\s*<ReloadHoldStatus \/>/)
		expect(index).not.toMatch(/process\.env\.REACT_APP_QA_ACK_ORDER_HOOK === 'true' && <ReloadHoldStatus/)
	})
})

describe('the queue reports the firm clock; a retry that fails again does not restart it', () => {
	const memoryDisk = (): QueueDocAdapter => {
		const docs = new Map<string, string>()
		return { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
	}
	const item: QueueItem = { v: 1, sendId: 'f1', peer: '0xcccc000000000000000000000000000000000003', text: 'x', createdAt: 1, queuedAt: 1 }
	it('failed twice: firmSince stays at the first moment; becoming awaiting clears it', async () => {
		let now = 1000
		const holds: Array<{ firmSince: number | null; firm: number }> = []
		const q = createSendQueue({
			store: createQueueStore({ eoa: '0xaaaa000000000000000000000000000000000001', doc: memoryDisk(), codec: base64JsonCodec() }),
			peer: item.peer, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, now: () => now, onHold: (h) => holds.push(h), heartbeatMs: 0,
		})
		await q.enqueue(item)
		await q.run('f1', async () => ({ kind: 'failed' }))
		const first = holds[holds.length - 1]
		expect(first.firm).toBe(1)
		expect(first.firmSince).toBe(1000)
		now = 90_000
		await q.run('f1', async () => ({ kind: 'failed' }))
		expect(holds[holds.length - 1].firmSince).toBe(1000)
		await q.run('f1', async () => ({ kind: 'awaiting', persisted: true }))
		expect(holds[holds.length - 1]).toMatchObject({ firm: 0, firmSince: null })
		q.dispose()
	})
})
