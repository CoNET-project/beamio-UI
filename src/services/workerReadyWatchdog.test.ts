/**
 * R79-watchdog: the gossip worker start that never reaches `ready` is bounded, and the stall names the page-side step where it stopped.
 * The ready-phase timers (sign, wrap) run only after `ready`; this bound covers the start before it. SYNTHETIC: no worker is created.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { WORKER_READY_TIMEOUT, WORKER_READY_TIMEOUT_MS, WorkerReadyTimeout, withWorkerReadyWatchdog } from './workerReadyWatchdog'

const SRC = join(__dirname, '..')

describe('gossip worker ready watchdog (R79)', () => {
	afterEach(() => {
		jest.useRealTimers()
	})

	it('a start that answers in time resolves with its value and is not named as a stall', async () => {
		await expect(withWorkerReadyWatchdog(Promise.resolve('ready'), () => 'init_sent')).resolves.toBe('ready')
	})

	it('a start that never answers rejects with worker_ready_timeout after the bound, naming the step where it stopped', async () => {
		jest.useFakeTimers()
		let step = 'init_sent'
		const never = new Promise<string>(() => undefined)
		const p = withWorkerReadyWatchdog(never, () => step)
		jest.advanceTimersByTime(WORKER_READY_TIMEOUT_MS - 1)
		await Promise.resolve()
		jest.advanceTimersByTime(1)
		const err = await p.catch((e: unknown) => e)
		expect(err).toBeInstanceOf(WorkerReadyTimeout)
		expect((err as Error).message).toBe(WORKER_READY_TIMEOUT)
		expect((err as WorkerReadyTimeout).step).toBe('init_sent')
	})

	it('the step is read when the watchdog fires (the last page-side step, not the one at the start)', async () => {
		jest.useFakeTimers()
		let step = 'worker_created'
		const never = new Promise<string>(() => undefined)
		const p = withWorkerReadyWatchdog(never, () => step)
		step = 'nodes_loaded'
		jest.advanceTimersByTime(WORKER_READY_TIMEOUT_MS)
		await expect(p).rejects.toMatchObject({ step: 'nodes_loaded' })
	})

	it('the bridge wires the watchdog around the client init, and the SDK client records its steps (source check)', () => {
		const bridge = readFileSync(join(SRC, 'services', 'chatWorkerBridge.ts'), 'utf8')
		expect(bridge).toMatch(/withWorkerReadyWatchdog\(client\.init\(\), \(\) => client\.startStep \?\? ''\)/)
		expect(bridge).toMatch(/class=\$\{WORKER_READY_TIMEOUT\} step=\$\{ex\.step\}/)
		const sdk = readFileSync(join(SRC, '..', 'vendor', 'conet-chat-sdk', 'src', 'client.ts'), 'utf8')
		expect(sdk).toMatch(/this\.startStepName = 'init_sent'/)
		expect(sdk).toMatch(/this\.startStepName = 'worker_created'/)
	})
})
