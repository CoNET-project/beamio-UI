import { createChatMediaBridge, MediaTimeoutError, type WorkerLike } from './chatMediaBridgeCore'
import type { ChatMediaWorkerRequest } from '../workers/chatMedia/protocol'

class FakeWorker implements WorkerLike {
	onmessage: WorkerLike['onmessage'] = null
	onerror: WorkerLike['onerror'] = null
	posted: ChatMediaWorkerRequest[] = []
	terminated = false
	postMessage(m: ChatMediaWorkerRequest) { this.posted.push(m) }
	terminate() { this.terminated = true }
	ready() { this.onmessage?.({ data: { type: 'ready' } }) }
	answer(i = this.posted.length - 1) {
		const plain = new Uint8Array([1, 2, 3]).buffer
		this.onmessage?.({ data: { type: 'decrypt-result', reqId: this.posted[i].reqId, ok: true, kind: 'plain', plain } })
	}
	fail(i = this.posted.length - 1) {
		this.onmessage?.({ data: { type: 'decrypt-result', reqId: this.posted[i].reqId, ok: false, error: 'bad key' } })
	}
}

const body = (bytes = 10) => new Blob([new Uint8Array(bytes)])
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function setup(overrides: Partial<Parameters<typeof createChatMediaBridge>[0]> = {}) {
	let clock = 0
	const timers: Array<{ at: number; cb: () => void; id: number }> = []
	let seq = 0
	const workers: FakeWorker[] = []
	const fallback = jest.fn(async () => ({ kind: 'plain' as const, plain: new ArrayBuffer(1) }))
	const logs: string[] = []
	const bridge = createChatMediaBridge({
		createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
		fallback,
		readyTimeoutMs: 8_000,
		requestTimeoutMs: () => 20_000,
		retryBaseMs: 30_000,
		retryMaxMs: 120_000,
		now: () => clock,
		setTimer: (cb, ms) => { const id = ++seq; timers.push({ at: clock + ms, cb, id }); return id },
		clearTimer: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
		log: (m) => logs.push(m),
		...overrides,
	})
	const advance = async (ms: number) => {
		clock += ms
		for (;;) {
			const due = timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at)[0]
			if (!due) break
			timers.splice(timers.indexOf(due), 1)
			due.cb()
			await flush()
		}
	}
	return { bridge, workers, fallback, logs, advance }
}

describe('chat media bridge', () => {
	it('decrypts in the worker and counts it', async () => {
		const { bridge, workers, fallback } = setup()
		const p = bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		workers[0].ready()
		workers[0].answer()
		await expect(p).resolves.toMatchObject({ kind: 'plain' })
		expect(fallback).not.toHaveBeenCalled()
		expect(bridge.stats()).toMatchObject({ workerStarts: 1, workerReady: 1, workerRequests: 1, workerOk: 1, fallbackRequests: 0 })
	})

	it('passes a decrypt error through (wrong key is not a worker failure)', async () => {
		const { bridge, workers, fallback } = setup()
		const p = bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		workers[0].ready()
		workers[0].fail()
		await expect(p).rejects.toThrow('bad key')
		expect(fallback).not.toHaveBeenCalled()
		expect(bridge.stats().workerAlive).toBe(true)
	})

	it('times out a hung request, frees it with a message, and replaces the worker', async () => {
		const { bridge, workers, advance } = setup()
		const hung = bridge.decryptFragmentBody(body(), true, 'k', 'i', true)
		workers[0].ready()
		const settled = hung.then(() => 'resolved', (e) => e)
		await advance(20_000)
		const error = await settled
		expect(error).toBeInstanceOf(MediaTimeoutError)
		expect((error as Error).message).toMatch(/took too long/)
		expect(workers[0].terminated).toBe(true)
		expect(bridge.stats()).toMatchObject({ timeouts: 1, workerAlive: false })
	})

	it('finishes other in-flight requests on the main thread when the worker is replaced', async () => {
		const { bridge, workers, fallback, advance } = setup({ requestTimeoutMs: (bytes) => (bytes > 100 ? 20_000 : 60_000) })
		const big = bridge.decryptFragmentBody(body(1000), true, 'k', 'i', true).catch(e => e)
		const small = bridge.decryptFragmentBody(body(10), true, 'k', 'i', false)
		workers[0].ready()
		await advance(20_000)
		expect(await big).toBeInstanceOf(MediaTimeoutError)
		await expect(small).resolves.toMatchObject({ kind: 'plain' })
		expect(fallback).toHaveBeenCalledTimes(1)
	})

	it('falls back when the worker never says ready, then retries a new worker after the back-off', async () => {
		const { bridge, workers, fallback, advance } = setup()
		const first = bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		await advance(8_000) // ready timeout
		await expect(first).resolves.toMatchObject({ kind: 'plain' })
		expect(fallback).toHaveBeenCalledTimes(1)

		// Within the back-off: straight to the fallback, no new worker.
		await bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(1)
		expect(fallback).toHaveBeenCalledTimes(2)

		// After 30 s: one new worker is tried (not permanent).
		await advance(30_000)
		const third = bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(2)
		workers[1].ready()
		workers[1].answer()
		await expect(third).resolves.toMatchObject({ kind: 'plain' })
		expect(bridge.stats()).toMatchObject({ workerStarts: 2, workerFailures: 1, workerOk: 1, fallbackRequests: 2 })
	})

	it('doubles the back-off on repeated failures (30 s, 60 s, capped)', async () => {
		const { bridge, workers, advance } = setup()
		void bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		workers[0].onerror?.({ message: 'script 404' })
		await flush()
		await advance(30_000)
		void bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(2)
		workers[1].onerror?.({ message: 'script 404' })
		await flush()
		await advance(30_000)
		void bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(2) // still backing off (60 s)
		await advance(30_000)
		void bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(3)
	})

	it('uses the fallback when the worker cannot be constructed, and tries again later', async () => {
		let allow = false
		const workers: FakeWorker[] = []
		const { bridge, fallback, advance } = setup({
			createWorker: () => { if (!allow) throw new Error('blocked'); const w = new FakeWorker(); workers.push(w); return w },
		})
		await expect(bridge.decryptFragmentBody(body(), true, 'k', 'i', false)).resolves.toMatchObject({ kind: 'plain' })
		expect(fallback).toHaveBeenCalledTimes(1)
		allow = true
		await advance(30_000)
		void bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		expect(workers).toHaveLength(1)
	})

	it('a worker crash mid-request finishes that request on the main thread', async () => {
		const { bridge, workers, fallback } = setup()
		const p = bridge.decryptFragmentBody(body(), true, 'k', 'i', false)
		workers[0].ready()
		workers[0].onerror?.({ message: 'crashed' })
		await expect(p).resolves.toMatchObject({ kind: 'plain' })
		expect(fallback).toHaveBeenCalledTimes(1)
	})
})
