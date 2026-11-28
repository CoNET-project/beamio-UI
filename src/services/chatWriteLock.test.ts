/**
 * @jest-environment node
 */
// writes hold a counting lock; the page's own refreshes wait for the LAST writer's commit, are merged, and an older read never replaces a newer write. SYNTHETIC.
import { beginChatWrite, runChatWrite, isChatWriting, deferWhileWriting, chatWriteVersion, readIsStale, requestControlledReload, resetChatWriteLockForTest, noteMessageSaving, noteMessageSaved, noteMessageDropped, hasUnsavedMessages } from './chatWriteLock'

beforeEach(() => resetChatWriteLockForTest())

describe('the lock is a counter', () => {
	it('with two writers the first to finish does not release: only the last one does', () => {
		const a = beginChatWrite()
		const b = beginChatWrite()
		a()
		expect(isChatWriting()).toBe(true)
		b()
		expect(isChatWriting()).toBe(false)
	})
	it('releasing twice does not unlock someone else (idempotent per writer)', () => {
		const a = beginChatWrite()
		const b = beginChatWrite()
		a()
		a()
		expect(isChatWriting()).toBe(true)
		b()
		expect(isChatWriting()).toBe(false)
	})
	it('a task that throws releases the lock (the UI is never locked for good)', async () => {
		await expect(runChatWrite(async () => { throw new Error('persist_write_failed') })).rejects.toThrow('persist_write_failed')
		expect(isChatWriting()).toBe(false)
	})
	it('a task holds the lock until it has settled', async () => {
		let release: () => void = () => undefined
		const p = runChatWrite(() => new Promise<void>((r) => { release = r }))
		expect(isChatWriting()).toBe(true)
		release()
		await p
		expect(isChatWriting()).toBe(false)
	})
})

describe('refreshes are suspended, merged, and run once after the last commit', () => {
	it('idle: the action runs at once', () => {
		const run = jest.fn()
		expect(deferWhileWriting('chat-reflash', run)).toBe(false)
		expect(run).toHaveBeenCalledTimes(1)
	})
	it('during a write several requests with the same key are one; it runs when the last writer releases, not before', () => {
		const run = jest.fn()
		const a = beginChatWrite()
		const b = beginChatWrite()
		expect(deferWhileWriting('chat-reflash', run)).toBe(true)
		deferWhileWriting('chat-reflash', run)
		deferWhileWriting('chat-reflash', run)
		a()
		expect(run).not.toHaveBeenCalled()
		b()
		expect(run).toHaveBeenCalledTimes(1)
	})
	it('different keys each run once (the re-read and the history overlay)', () => {
		const reflash = jest.fn()
		const overlay = jest.fn()
		const w = beginChatWrite()
		deferWhileWriting('chat-reflash', reflash)
		deferWhileWriting('history-overlay', overlay)
		w()
		expect(reflash).toHaveBeenCalledTimes(1)
		expect(overlay).toHaveBeenCalledTimes(1)
	})
	it('an action that throws does not stop the others, and the lock stays released', () => {
		const ok = jest.fn()
		const w = beginChatWrite()
		deferWhileWriting('a', () => { throw new Error('x') })
		deferWhileWriting('b', ok)
		w()
		expect(ok).toHaveBeenCalledTimes(1)
		expect(isChatWriting()).toBe(false)
	})
	it('a failed write releases the interactive lock; the held in-app refresh (read and merge only) runs; a held RELOAD does not run while the message is only in memory', async () => {
		const refresh = jest.fn()
		const reload = jest.fn()
		const p = runChatWrite(async () => {
			noteMessageSaving('tmp_1')
			deferWhileWriting('chat-reflash', refresh)
			requestControlledReload(reload)
			throw new Error('write failed')
		}).catch(() => undefined)
		expect(refresh).not.toHaveBeenCalled()
		await p
		expect(isChatWriting()).toBe(false) // the user can retry: nothing is locked for good
		expect(refresh).toHaveBeenCalledTimes(1)
		expect(reload).not.toHaveBeenCalled() // the message exists only in memory: the reload stays held
		expect(hasUnsavedMessages()).toBe(true)
	})
	it('the held reload runs exactly once when the record has landed (the retry), not before', () => {
		const reload = jest.fn()
		noteMessageSaving('tmp_1')
		requestControlledReload(reload)
		expect(reload).not.toHaveBeenCalled()
		const w = beginChatWrite() // the retry writes
		w() // lock free, record still not saved
		expect(reload).not.toHaveBeenCalled()
		noteMessageSaved('tmp_1')
		expect(reload).toHaveBeenCalledTimes(1)
		noteMessageSaved('tmp_1')
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('a message that has landed before is not memory-only again when a later update of it fails', () => {
		const reload = jest.fn()
		noteMessageSaving('m')
		noteMessageSaved('m')
		noteMessageSaving('m') // a later write of the same message
		requestControlledReload(reload)
		expect(hasUnsavedMessages()).toBe(false)
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('with several unsaved messages the reload waits for the LAST one; a message the user dropped on purpose holds nothing back', () => {
		const reload = jest.fn()
		noteMessageSaving('a')
		noteMessageSaving('b')
		requestControlledReload(reload)
		noteMessageSaved('a')
		expect(reload).not.toHaveBeenCalled()
		noteMessageDropped('b')
		expect(reload).toHaveBeenCalledTimes(1)
	})
	it('a controlled reload is held while a write runs, merged into one, and done once after the commit; idle it runs at once', () => {
		const reload = jest.fn()
		expect(requestControlledReload(reload)).toBe(false)
		expect(reload).toHaveBeenCalledTimes(1)
		resetChatWriteLockForTest() // the page that reloaded is gone: the next one starts clean
		const w = beginChatWrite()
		requestControlledReload(reload)
		requestControlledReload(reload)
		expect(reload).toHaveBeenCalledTimes(1)
		w()
		expect(reload).toHaveBeenCalledTimes(2)
	})

	it('a burst of requests in the same turn is ONE reload; idle and held alike', () => {
		const idle = jest.fn()
		expect(requestControlledReload(idle)).toBe(false) // the first runs
		expect(requestControlledReload(idle)).toBe(true) // merged into it
		expect(requestControlledReload(idle)).toBe(true)
		expect(idle).toHaveBeenCalledTimes(1)
		resetChatWriteLockForTest()
		const held = jest.fn()
		const w = beginChatWrite()
		for (let i = 0; i < 3; i++) requestControlledReload(held)
		expect(held).not.toHaveBeenCalled()
		w()
		expect(held).toHaveBeenCalledTimes(1)
		requestControlledReload(held) // the page is reloading: merged
		expect(held).toHaveBeenCalledTimes(1)
	})

	it('a reload that did not unload the page can be asked for again after the merge window', () => {
		const now = jest.spyOn(Date, 'now')
		now.mockReturnValue(1_000_000)
		const reload = jest.fn()
		requestControlledReload(reload)
		now.mockReturnValue(1_000_000 + 4_000)
		requestControlledReload(reload)
		expect(reload).toHaveBeenCalledTimes(1)
		now.mockReturnValue(1_000_000 + 5_500)
		requestControlledReload(reload)
		expect(reload).toHaveBeenCalledTimes(2)
		now.mockRestore()
	})
})

describe('an older read never replaces a newer write', () => {
	it('a read that began before a write is stale once the write has started', () => {
		const v = chatWriteVersion()
		expect(readIsStale(v)).toBe(false)
		const w = beginChatWrite()
		expect(readIsStale(v)).toBe(true)
		w()
		expect(readIsStale(v)).toBe(true) // it stays stale after the write: it must be read again
		expect(readIsStale(chatWriteVersion())).toBe(false)
	})
})

describe('there is no timer in the lock (static)', () => {
	it('chatWriteLock.ts uses no setTimeout/setInterval', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chatWriteLock.ts'), 'utf8')
		expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/setTimeout|setInterval/)
	})
})

describe('the QA state and the in-page entry', () => {
	it('chatWriteLockState reports what is held, read only', () => {
		const { chatWriteLockState } = require('./chatWriteLock')
		expect(chatWriteLockState()).toEqual({ writing: false, unsaved: 0, queued: 0, awaiting: 0, dirtyDrafts: 0, inFlight: 0, heldReload: false, heldRefreshes: 0 })
		noteMessageSaving('m')
		const w = beginChatWrite()
		requestControlledReload(() => undefined)
		deferWhileWriting('chat-reflash', () => undefined)
		expect(chatWriteLockState()).toEqual({ writing: true, unsaved: 1, queued: 0, awaiting: 0, dirtyDrafts: 0, inFlight: 0, heldReload: true, heldRefreshes: 1 })
		w()
		noteMessageSaved('m')
	})
	it('the page entries are installed on window in every build (static)', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chatWriteLock.ts'), 'utf8')
		expect(src).toMatch(/w\.__beamioRequestControlledReload = \(\) => requestControlledReload\(\)/)
		expect(src).toMatch(/w\.__beamioChatWriteLockState = \(\) => chatWriteLockState\(\)/)
	})
})

