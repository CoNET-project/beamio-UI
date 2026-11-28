/**
 * @jest-environment node
 */
// item 8: "Loading earlier messages…" ends once the library sync has run; it runs once, never in a loop.
import { createLocalSyncOnce, followUpOlderPending } from './chatLocalSyncOnce'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** a library whose page says 'pending' at the oldest row until syncLocal has set syncComplete (as the SDK store does) */
const fakeLibrary = (opts: { syncFails?: boolean } = {}) => {
	let syncComplete = false
	let syncCalls = 0
	let release: () => void = () => undefined
	const gate = new Promise<void>((r) => { release = r })
	return {
		history: {
			syncLocal: async () => {
				syncCalls += 1
				await gate
				if (opts.syncFails) throw new Error('sync failed')
				syncComplete = true
			},
		},
		page: () => ({ olderState: syncComplete ? 'end' : 'pending' }),
		syncCalls: () => syncCalls,
		release,
	}
}

describe('library older-pending follow-up', () => {
	it('reaching the oldest row shows pending until the sync ran once, then end (one re-read, one sync)', async () => {
		const lib = fakeLibrary()
		const once = createLocalSyncOnce(() => lib.history)
		let rereads = 0
		let pending = lib.page().olderState === 'pending'
		expect(pending).toBe(true)
		const reread = () => {
			rereads += 1
			const state = lib.page().olderState
			pending = state === 'pending'
			void followUpOlderPending(state, once, reread)
		}
		const first = followUpOlderPending(lib.page().olderState, once, reread)
		await flush()
		expect(lib.syncCalls()).toBe(1)
		expect(pending).toBe(true) // the first screen is not blocked and the sync is still running
		lib.release()
		await first
		await flush()
		expect(pending).toBe(false)
		expect(rereads).toBe(1)
		expect(lib.syncCalls()).toBe(1)
	})

	it('does not run while another run is in flight (single flight)', async () => {
		const lib = fakeLibrary()
		const once = createLocalSyncOnce(() => lib.history)
		const a = once.run()
		const b = once.run()
		const c = once.run()
		lib.release()
		expect(await a).toBe(true)
		expect(await b).toBeNull()
		expect(await c).toBeNull()
		expect(lib.syncCalls()).toBe(1)
	})

	it('a failed sync is not retried in a loop: still pending, one attempt, no re-read', async () => {
		const lib = fakeLibrary({ syncFails: true })
		const once = createLocalSyncOnce(() => lib.history)
		const reread = jest.fn()
		lib.release()
		await followUpOlderPending('pending', once, reread)
		await followUpOlderPending('pending', once, reread)
		await followUpOlderPending('pending', once, reread)
		expect(lib.syncCalls()).toBe(1)
		expect(reread).not.toHaveBeenCalled()
	})

	it('no client yet consumes nothing; the next call with a client runs', async () => {
		let h: { syncLocal: () => Promise<void> } | null = null
		const once = createLocalSyncOnce(() => h)
		expect(await once.run()).toBeNull()
		const syncLocal = jest.fn(async () => undefined)
		h = { syncLocal }
		expect(await once.run()).toBe(true)
		expect(syncLocal).toHaveBeenCalledTimes(1)
	})

	it('a new history client (re-created after a lock or account change) gets its own one run', async () => {
		const a = { syncLocal: jest.fn(async () => undefined) }
		const b = { syncLocal: jest.fn(async () => undefined) }
		let cur: typeof a = a
		const once = createLocalSyncOnce(() => cur)
		await once.run()
		await once.run()
		cur = b
		await once.run()
		expect(a.syncLocal).toHaveBeenCalledTimes(1)
		expect(b.syncLocal).toHaveBeenCalledTimes(1)
	})

	it('a client without syncLocal (native shell stubs) is one false attempt, no throw', async () => {
		const stub = {}
		const once = createLocalSyncOnce(() => stub)
		expect(await once.run()).toBe(false)
		expect(await once.run()).toBeNull()
	})

	it('states other than pending (more, end) never start a sync', async () => {
		const syncLocal = jest.fn(async () => undefined)
		const once = createLocalSyncOnce(() => ({ syncLocal }))
		await followUpOlderPending('more', once, jest.fn())
		await followUpOlderPending('end', once, jest.fn())
		expect(syncLocal).not.toHaveBeenCalled()
	})
})
