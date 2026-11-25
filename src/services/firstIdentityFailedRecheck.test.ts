/**
 * 0.53.52: the SDK latches `failed` and then sends no `registered` even if its own retry succeeds in the same process. While the failed notice is shown the
 * page re-reads identityPublic at a low rate and leaves the notice when the identity is ready. Fake timers. SYNTHETIC.
 */
import { FIRST_IDENTITY_FAILED_RECHECK_MS, watchFirstIdentityFailed } from './firstIdentityFailedRecheck'
import { getFirstIdentitySetup, setFirstIdentitySetup } from './shellFirstIdentitySetup'

const EVERY = FIRST_IDENTITY_FAILED_RECHECK_MS
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

let stops: Array<() => void> = []
const watch = (readReady: () => Promise<boolean>, onReady: () => void = jest.fn(), extra: { intervalMs?: number } = {}) => {
	const stop = watchFirstIdentityFailed({ readReady, onReady, ...extra })
	stops.push(stop)
	return { onReady }
}

beforeEach(() => {
	jest.useFakeTimers()
	setFirstIdentitySetup('idle')
})
afterEach(() => {
	stops.forEach((s) => s())
	stops = []
	setFirstIdentitySetup('idle')
	jest.useRealTimers()
})

describe('the low-rate re-read while the failed notice is shown', () => {
	it('the rate is at most one read a minute, even if a faster interval is asked for', async () => {
		expect(EVERY).toBeGreaterThanOrEqual(60_000)
		const read = jest.fn(async () => false)
		watch(read, jest.fn(), { intervalMs: 1000 })
		setFirstIdentitySetup('failed')
		jest.advanceTimersByTime(EVERY - 1)
		await flush()
		expect(read).not.toHaveBeenCalled()
		jest.advanceTimersByTime(1)
		await flush()
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('not ready: it keeps the failed notice and reads again a minute later, and again, no faster', async () => {
		const read = jest.fn(async () => false)
		watch(read)
		setFirstIdentitySetup('failed')
		for (let i = 1; i <= 4; i++) {
			jest.advanceTimersByTime(EVERY)
			await flush()
			expect(read).toHaveBeenCalledTimes(i)
		}
		expect(getFirstIdentitySetup()).toBe('failed')
	})

	it('ready: the identity is read ready, so onReady runs once, the reads stop, and the page is not asked again', async () => {
		let ready = false
		const read = jest.fn(async () => ready)
		const { onReady } = watch(read)
		setFirstIdentitySetup('failed')
		jest.advanceTimersByTime(EVERY)
		await flush()
		expect(onReady).not.toHaveBeenCalled()
		ready = true
		jest.advanceTimersByTime(EVERY)
		await flush()
		expect(onReady).toHaveBeenCalledTimes(1)
		jest.advanceTimersByTime(10 * EVERY)
		await flush()
		expect(read).toHaveBeenCalledTimes(2)
		expect(onReady).toHaveBeenCalledTimes(1)
	})

	it('a read that throws is not ready: it keeps trying', async () => {
		let n = 0
		const read = jest.fn(async () => {
			n += 1
			if (n < 3) throw new Error('native not answering')
			return true
		})
		const { onReady } = watch(read)
		setFirstIdentitySetup('failed')
		for (let i = 0; i < 3; i++) {
			jest.advanceTimersByTime(EVERY)
			await flush()
		}
		expect(onReady).toHaveBeenCalledTimes(1)
	})

	it('it starts only when the state is failed, and stops when the state leaves failed (a new run, a registered event)', async () => {
		const read = jest.fn(async () => false)
		watch(read)
		setFirstIdentitySetup('setting_up')
		jest.advanceTimersByTime(5 * EVERY)
		await flush()
		expect(read).not.toHaveBeenCalled()
		setFirstIdentitySetup('failed')
		jest.advanceTimersByTime(EVERY)
		await flush()
		expect(read).toHaveBeenCalledTimes(1)
		setFirstIdentitySetup('idle')
		jest.advanceTimersByTime(5 * EVERY)
		await flush()
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('failed again after a pause starts a fresh minute (no double timers)', async () => {
		const read = jest.fn(async () => false)
		watch(read)
		setFirstIdentitySetup('failed')
		setFirstIdentitySetup('idle')
		setFirstIdentitySetup('failed')
		setFirstIdentitySetup('failed')
		jest.advanceTimersByTime(EVERY)
		await flush()
		expect(read).toHaveBeenCalledTimes(1)
	})

	it('the state left failed while a read was running: nothing is started even if that read says ready', async () => {
		let release: (v: boolean) => void = () => undefined
		const read = jest.fn(() => new Promise<boolean>((res) => { release = res }))
		const { onReady } = watch(read)
		setFirstIdentitySetup('failed')
		jest.advanceTimersByTime(EVERY)
		await flush()
		setFirstIdentitySetup('idle')
		release(true)
		await flush()
		expect(onReady).not.toHaveBeenCalled()
	})

	it('already failed when the watcher is installed: it still starts', async () => {
		setFirstIdentitySetup('failed')
		const read = jest.fn(async () => false)
		watch(read)
		jest.advanceTimersByTime(EVERY)
		await flush()
		expect(read).toHaveBeenCalledTimes(1)
	})
})

describe('the wiring in chat.ts (source)', () => {
	const fs = require('fs')
	const path = require('path')
	it('the ready read is identityPublic ok with pgpReady true; ready leaves the failed notice and starts the chat', () => {
		const src: string = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
		const at = src.indexOf('watchFirstIdentityFailed({')
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at, at + 600)
		expect(block).toContain('readNativeIdentityPublic()')
		expect(block).toContain("id.kind === 'ok' && id.pgpReady === true")
		expect(block).toContain("setFirstIdentitySetup('idle')")
		expect(block).toContain('startShellChatNow()')
	})
})
