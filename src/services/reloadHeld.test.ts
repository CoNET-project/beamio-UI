// a reload the user asked for that is held is never silent (requestUserReload + the held-notice copy).
import { beginChatWrite, setQueueDepth, noteDraftDirty, noteDraftSaved, noteMessageSaved, noteMessageSaving, noteRequestInFlight, noteRequestSettled, onUserReloadHeld, reloadHoldReason, requestUserReload, resetChatWriteLockForTest, type ReloadHoldReason } from './chatWriteLock'
import { reloadHeldCopyKey } from './reloadHeldNotice'

jest.mock('@/locale/beamioToast', () => ({ showBeamioToastUi: jest.fn() }))

describe('requestUserReload', () => {
	beforeEach(() => resetChatWriteLockForTest())

	it('idle: runs at once and tells nobody', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		const reload = jest.fn()
		expect(requestUserReload(reload)).toBe(false)
		expect(reload).toHaveBeenCalledTimes(1)
		expect(heard).toEqual([])
	})

	it('held by a write: the listener hears "writing", the reload runs once when the write is done', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		const release = beginChatWrite()
		const reload = jest.fn()
		expect(requestUserReload(reload)).toBe(true)
		expect(heard).toEqual(['writing'])
		expect(reload).not.toHaveBeenCalled()
		release()
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it('held by a message that exists only in memory: "unsaved", and a Retry that lands runs it once', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		noteMessageSaving('m1')
		const reload = jest.fn()
		expect(requestUserReload(reload)).toBe(true)
		expect(heard).toEqual(['unsaved'])
		requestUserReload(reload) // a second tap is heard again, and is still one reload
		expect(heard).toEqual(['unsaved', 'unsaved'])
		noteMessageSaved('m1')
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it('held by an unwritten draft ("draft") or a request in flight ("inflight")', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		noteDraftDirty('peer')
		const reload = jest.fn()
		requestUserReload(reload)
		expect(reloadHoldReason()).toBe('draft')
		noteDraftSaved('peer')
		expect(reload).toHaveBeenCalledTimes(1)
		resetChatWriteLockForTest() // the page that reloaded is gone
		onUserReloadHeld((r) => heard.push(r))
		noteRequestInFlight('x')
		const reload2 = jest.fn()
		requestUserReload(reload2)
		expect(heard).toEqual(['draft', 'inflight'])
		noteRequestSettled('x')
		expect(reload2).toHaveBeenCalledTimes(1)
	})

	it('held by the send queue ("queue"): the tap says so, and the last item leaving releases it once', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld((r) => heard.push(r))
		setQueueDepth('acct:peer', 2)
		const reload = jest.fn()
		expect(requestUserReload(reload)).toBe(true)
		expect(heard).toEqual(['queue'])
		setQueueDepth('acct:peer', 1)
		expect(reload).not.toHaveBeenCalled()
		setQueueDepth('acct:peer', 0)
		expect(reload).toHaveBeenCalledTimes(1)
	})

	it('a listener that throws does not stop the others', () => {
		const heard: ReloadHoldReason[] = []
		onUserReloadHeld(() => { throw new Error('boom') })
		onUserReloadHeld((r) => heard.push(r))
		noteMessageSaving('m')
		requestUserReload(jest.fn())
		expect(heard).toEqual(['unsaved'])
	})

	it('the copy: "unsaved" tells the user to Retry, every other reason says it is saving first', () => {
		expect(reloadHeldCopyKey('unsaved')).toBe('chat.reload.held_unsaved')
		expect(reloadHeldCopyKey('queue')).toBe('chat.reload.held_failed')
		expect(reloadHeldCopyKey('awaiting')).toBe('chat.reload.held_awaiting')
		for (const r of ['writing', 'draft', 'inflight'] as const) expect(reloadHeldCopyKey(r)).toBe('chat.reload.held_saving')
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const en = (require('../locale/en.json') as { ui: Record<string, string> }).ui
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const zh = (require('../locale/zh-CN.json') as { ui: Record<string, string> }).ui
		for (const k of ['chat.reload.held_unsaved', 'chat.reload.held_saving', 'chat.reload.held_failed', 'chat.reload.held_awaiting', 'chat.status.awaiting_ack']) {
			expect(en[k]).toBeTruthy()
			expect(zh[k]).toBeTruthy()
		}
	})
})
