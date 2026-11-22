/**
 *the beamioTag database open never hangs silently. A blocked open fails with a named error; a stalled open fails after
 * OPEN_DB_TIMEOUT_MS; a failed open is not cached (a later call opens again); a late success after a timeout closes the connection.
 * A fake indexedDB; no real database.
 */
type FakeReq = {
	result: { close: jest.Mock; transaction?: unknown; objectStoreNames?: unknown }
	onblocked?: () => void
	onsuccess?: () => void
	onerror?: () => void
	onupgradeneeded?: () => void
}

function installFake(): { open: jest.Mock; reqs: FakeReq[] } {
	const reqs: FakeReq[] = []
	const open = jest.fn(() => {
		const req: FakeReq = { result: { close: jest.fn() } }
		reqs.push(req)
		return req
	})
	;(globalThis as { indexedDB?: unknown }).indexedDB = { open }
	return { open, reqs }
}

function loadStore(): typeof import('./idbStore') {
	let mod: typeof import('./idbStore') | undefined
	jest.isolateModules(() => {
		mod = require('./idbStore') as typeof import('./idbStore')
	})
	return mod as typeof import('./idbStore')
}

const RECORD = { addressLower: '0x' + '1'.repeat(40) } as never

describe('beamioTag database open', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('a blocked open fails with the named blocked error (no silent wait)', async () => {
		const fake = installFake()
		const store = loadStore()
		const p = store.idbPutMany('partition', { k: RECORD })
		fake.reqs[0].onblocked?.()
		await expect(p).rejects.toThrow(store.OPEN_DB_BLOCKED)
	})

	it('a stalled open fails with the named timeout error after OPEN_DB_TIMEOUT_MS', async () => {
		jest.useFakeTimers()
		installFake()
		const store = loadStore()
		const p = store.idbPutMany('partition', { k: RECORD })
		jest.advanceTimersByTime(store.OPEN_DB_TIMEOUT_MS)
		await expect(p).rejects.toThrow(store.OPEN_DB_TIMEOUT)
	})

	it('a failed open is not cached: the next call opens the database again', async () => {
		const fake = installFake()
		const store = loadStore()
		const first = store.idbPutMany('partition', { k: RECORD })
		fake.reqs[0].onblocked?.()
		await expect(first).rejects.toThrow(store.OPEN_DB_BLOCKED)
		// the rejection is caught at once, so a failing expectation below cannot leave it unhandled
		const second = store.idbPutMany('partition', { k: RECORD }).then(() => 'resolved', (e: Error) => e.message)
		fake.reqs[1]?.onblocked?.()
		expect(fake.open).toHaveBeenCalledTimes(2)
		expect(await second).toBe(store.OPEN_DB_BLOCKED)
	})

	it('a late success after the timeout closes the late connection (it is not kept)', async () => {
		jest.useFakeTimers()
		const fake = installFake()
		const store = loadStore()
		const p = store.idbPutMany('partition', { k: RECORD })
		jest.advanceTimersByTime(store.OPEN_DB_TIMEOUT_MS)
		await expect(p).rejects.toThrow(store.OPEN_DB_TIMEOUT)
		fake.reqs[0].onsuccess?.()
		expect(fake.reqs[0].result.close).toHaveBeenCalledTimes(1)
	})
})
