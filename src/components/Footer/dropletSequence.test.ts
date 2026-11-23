/**
 * Timing regression for the footer droplet (2026-11-20). No `start` may run after `isLive()` turns false, and no phase may be
 * written after that. Covers the normal run, an unmount during a pending phase, a cancel before the first settle, fake timers, and load.
 */
import { runDropletSequence, type DropletControls, type DropletPhase } from './dropletSequence'

type Pending = { resolve: () => void }

function fakeControls() {
	const pending: Pending[] = []
	const starts: number[] = []
	const controls: DropletControls & { stop: jest.Mock } = {
		set: jest.fn(),
		start: jest.fn(() => {
			starts.push(starts.length)
			return new Promise<void>((resolve) => pending.push({ resolve }))
		}) as unknown as DropletControls['start'],
		stop: jest.fn(),
	}
	return { controls, pending, starts }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('runDropletSequence', () => {
	it('runs the three phases in order and ends idle', async () => {
		const { controls, pending } = fakeControls()
		const phases: DropletPhase[] = []
		const done = runDropletSequence({ controls, isLive: () => true, startX: 1, setPhase: (p) => phases.push(p) })
		await flush()
		expect(controls.start).toHaveBeenCalledTimes(1)
		pending[0].resolve()
		await flush()
		pending[1].resolve()
		await flush()
		pending[2].resolve()
		await done
		expect(controls.start).toHaveBeenCalledTimes(3)
		expect(phases).toEqual(['moving', 'settling', 'idle'])
	})

	it('unmount during the second phase: the third phase never starts and no phase is written after it', async () => {
		let live = true
		const { controls, pending } = fakeControls()
		const phases: DropletPhase[] = []
		const done = runDropletSequence({ controls, isLive: () => live, startX: 0, setPhase: (p) => phases.push(p) })
		await flush()
		pending[0].resolve()
		await flush()
		expect(controls.start).toHaveBeenCalledTimes(2)
		live = false // unmount while phase two runs
		pending[1].resolve()
		await done
		expect(controls.start).toHaveBeenCalledTimes(2)
		expect(phases).toEqual(['moving', 'settling'])
	})

	it('cancel before the first phase settles: no second start', async () => {
		let live = true
		const { controls, pending } = fakeControls()
		const done = runDropletSequence({ controls, isLive: () => live, startX: 0, setPhase: () => undefined })
		await flush()
		live = false
		pending[0].resolve()
		await done
		expect(controls.start).toHaveBeenCalledTimes(1)
	})

	it('not live at the start: nothing is set or started', async () => {
		const { controls } = fakeControls()
		await runDropletSequence({ controls, isLive: () => false, startX: 0, setPhase: () => undefined })
		expect(controls.set).not.toHaveBeenCalled()
		expect(controls.start).not.toHaveBeenCalled()
	})

	describe('with fake timers (each phase settles after its duration)', () => {
		beforeEach(() => jest.useFakeTimers())
		afterEach(() => jest.useRealTimers())

		it('an unmount at 200 ms stops the sequence before the third start', async () => {
			let live = true
			const starts: number[] = []
			const controls: DropletControls = {
				set: () => undefined,
				start: ((values: { transition?: { duration: number } }) => {
					starts.push(starts.length)
					return new Promise<void>((resolve) => setTimeout(resolve, (values.transition?.duration ?? 0) * 1000))
				}) as unknown as DropletControls['start'],
				stop: () => undefined,
			}
			const done = runDropletSequence({ controls, isLive: () => live, startX: 0, setPhase: () => undefined })
			let elapsed = 0
			setTimeout(() => {
				live = false
			}, 200)
			// step the fake clock by hand (this Jest has no runAllTimersAsync); yield to microtasks between steps
			for (let i = 0; i < 100; i++) {
				jest.advanceTimersByTime(10)
				elapsed += 10
				for (let k = 0; k < 5; k++) await Promise.resolve()
			}
			await done
			expect(elapsed).toBe(1000)
			expect(starts.length).toBe(2) // phase 1 (120 ms) and phase 2 (140 ms) started; phase 3 did not
		})
	})

	it('load: 200 sequences cancelled at random points never start after their cancel', async () => {
		const runs = Array.from({ length: 200 }, (_, i) => {
			const { controls, pending } = fakeControls()
			let live = true
			const done = runDropletSequence({ controls, isLive: () => live, startX: 0, setPhase: () => undefined })
			return { i, controls, pending, done, kill: () => (live = false), startsAtKill: -1 }
		})
		await flush()
		for (let step = 1; step <= 4; step++) {
			for (const r of runs) {
				// cancel roughly a third of the runs, at a step that depends on the run index
				if (r.startsAtKill < 0 && step === (r.i % 4) + 1 && r.i % 3 === 0) {
					r.kill()
					r.startsAtKill = (r.controls.start as unknown as jest.Mock).mock.calls.length
				}
				const p = r.pending.shift()
				if (p) {
					p.resolve()
					await flush()
				}
			}
		}
		// drain whatever is still pending, so every run settles
		for (let guard = 0; guard < 10; guard++) {
			for (const r of runs) {
				const p = r.pending.shift()
				if (p) {
					p.resolve()
					await flush()
				}
			}
		}
		await Promise.all(runs.map((r) => r.done))
		let killed = 0
		for (const r of runs) {
			const total = (r.controls.start as unknown as jest.Mock).mock.calls.length
			expect(total).toBeLessThanOrEqual(3)
			if (r.startsAtKill >= 0) {
				killed++
				// after the cancel, no further start was issued for this run
				expect(total).toBe(r.startsAtKill)
			}
		}
		expect(killed).toBeGreaterThan(0)
	})
})
