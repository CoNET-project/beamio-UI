/**
 * the history load gate. The three rules: single-flight with one re-run for a different bypass reason; the minimum interval
 * for ordinary callers (30 s, an engineering default); the bypass callers (account change, foreground resume). Plus the numbers-only log.
 * The gate receives only the load and a logger: it has no read or notify hook, so a load cannot replay the history by itself (the
 * bridge's post-load replay is removed, checked in historyLoadWiring.static.test.ts). SYNTHETIC values only.
 */
import { createHistoryLoadGate, HISTORY_LOAD_MIN_INTERVAL_MS, strongerHistoryCaller, type HistoryLoadCaller } from './historyLoadGate'

/** A load the test completes by hand. */
function controlled() {
	let resolve!: () => void
	let reject!: (e: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { load: jest.fn(() => promise), resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let clock = 0
const now = () => clock
let lines: string[] = []
const log = (line: string) => lines.push(line)
/** the trailing timers are recorded, not run, so the tests stay on the fake clock. */
let timers: Array<{ fn: () => void; ms: number }> = []
const schedule = (fn: () => void, ms: number) => {
	timers.push({ fn, ms })
}

beforeEach(() => {
	clock = 1_000_000
	lines = []
	timers = []
})

describe('the minimum interval (30 s by default, configurable)', () => {
	it('the default is 30 seconds', () => {
		expect(HISTORY_LOAD_MIN_INTERVAL_MS).toBe(30_000)
	})

	it('an ordinary request within the interval after a load is skipped; after the interval it runs', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		const first = jest.fn(async () => undefined)
		await gate.request('listen_start', first)
		expect(first).toHaveBeenCalledTimes(1)

		clock += 29_000
		const second = jest.fn(async () => undefined)
		await gate.request('other', second)
		expect(second).not.toHaveBeenCalled()
		expect(lines.some((l) => l === '[history] skip caller=other reason=interval')).toBe(true)

		clock += 1_000
		const third = jest.fn(async () => undefined)
		await gate.request('other', third)
		expect(third).toHaveBeenCalledTimes(1)
	})

	it('the interval is configurable', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule, minIntervalMs: 5_000 })
		await gate.request('other', async () => undefined)
		clock += 5_000
		const again = jest.fn(async () => undefined)
		await gate.request('other', again)
		expect(again).toHaveBeenCalledTimes(1)
	})

	it('a bypass caller runs at once, inside the interval', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 1_000
		const account = jest.fn(async () => undefined)
		await gate.request('historyEoa_change', account)
		const resume = jest.fn(async () => undefined)
		await gate.request('foreground_resume', resume)
		expect(account).toHaveBeenCalledTimes(1)
		expect(resume).toHaveBeenCalledTimes(1)
	})
})

describe('single-flight and the one re-run', () => {
	it('ordinary requests during a load are covered by it: the load runs once', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		const a = controlled()
		const p1 = gate.request('listen_start', a.load)
		const p2 = gate.request('other', a.load)
		const p3 = gate.request('listen_start', a.load)
		expect(a.load).toHaveBeenCalledTimes(1)
		a.resolve()
		await Promise.all([p1, p2, p3])
		expect(a.load).toHaveBeenCalledTimes(1)
	})

	it('a bypass request for a different reason during a load runs once more after it', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		const a = controlled()
		const p1 = gate.request('listen_start', a.load)
		const p2 = gate.request('historyEoa_change', a.load)
		expect(a.load).toHaveBeenCalledTimes(1)
		a.resolve()
		await p1
		await p2
		await flush()
		expect(a.load).toHaveBeenCalledTimes(2)
	})

	it('the same bypass reason during a load is covered by it: no re-run', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		const a = controlled()
		const p1 = gate.request('historyEoa_change', a.load)
		const p2 = gate.request('historyEoa_change', a.load)
		a.resolve()
		await Promise.all([p1, p2])
		await flush()
		expect(a.load).toHaveBeenCalledTimes(1)
	})

	it('a failing load still completes, is logged, and sets the time the interval counts from', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => {
			throw new Error('sdk failed')
		})
		expect(lines).toHaveLength(1)
		expect(gate.state().lastDoneAt).toBe(clock)
		expect(gate.state().inFlight).toBe(false)
	})
})

describe('the log: the caller and numbers only', () => {
	it('one line per load: the caller, the time taken and the delivered count', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('foreground_resume', async () => {
			clock += 120
			gate.noteDelivered(3)
			gate.noteDelivered(4)
		})
		expect(lines).toEqual(['[history] load caller=foreground_resume ms=120 delivered=7'])
	})

	it('the line carries no address, no content and no key-shaped text', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('historyEoa_change', async () => {
			gate.noteDelivered(1)
		})
		for (const line of lines) {
			expect(line).toMatch(/^\[history\] load caller=(historyEoa_change|foreground_resume|listen_start|other) ms=\d+ delivered=\d+$/)
			expect(line).not.toMatch(/0x[0-9a-fA-F]{6}/)
		}
	})

	it('deliveries counted outside a load are not added to the next load', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		gate.noteDelivered(50)
		await gate.request('listen_start', async () => undefined)
		expect(lines[0]).toMatch(/delivered=0$/)
	})
})

describe('the caller order', () => {
	it('a bypass caller is stronger than an ordinary one, and between bypass callers the first stays', () => {
		expect(strongerHistoryCaller('other', 'historyEoa_change')).toBe('historyEoa_change')
		expect(strongerHistoryCaller('historyEoa_change', 'other')).toBe('historyEoa_change')
		expect(strongerHistoryCaller('listen_start', 'other')).toBe('listen_start')
		const same: HistoryLoadCaller = 'foreground_resume'
		expect(strongerHistoryCaller(same, 'historyEoa_change')).toBe('foreground_resume')
	})
})

describe('the trailing run of a skipped ordinary request', () => {
	it('a request skipped inside the interval gets one trailing run, scheduled for the remaining time, and it runs once', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 10_000
		const skipped = jest.fn(async () => undefined)
		await gate.request('other', skipped)
		expect(skipped).not.toHaveBeenCalled()
		expect(timers).toHaveLength(1)
		expect(timers[0].ms).toBe(HISTORY_LOAD_MIN_INTERVAL_MS - 10_000)
		expect(gate.state().trailing).toBe(true)

		clock += timers[0].ms
		const fire = timers[0].fn
		timers = []
		fire()
		await flush()
		expect(skipped).toHaveBeenCalledTimes(1)
		expect(gate.state().trailing).toBe(false)
	})

	it('several skipped requests share one timer and one run: the run is the last skipped load, and the stronger caller is kept', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 1_000
		const earlier = jest.fn(async () => undefined)
		await gate.request('other', earlier)
		clock += 1_000
		const later = jest.fn(async () => undefined)
		await gate.request('listen_start', later)
		expect(timers).toHaveLength(1)
		expect(timers[0].ms).toBe(HISTORY_LOAD_MIN_INTERVAL_MS - 1_000)

		clock += timers[0].ms
		const fire = timers[0].fn
		timers = []
		fire()
		await flush()
		expect(earlier).not.toHaveBeenCalled()
		expect(later).toHaveBeenCalledTimes(1)
		expect(lines.some((l) => l.startsWith('[history] load caller=other '))).toBe(true)
		expect(timers).toHaveLength(0)
	})

	it('a bypass request is never trailing: it runs at once, inside the interval', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 1_000
		const bypass = jest.fn(async () => undefined)
		await gate.request('foreground_resume', bypass)
		expect(bypass).toHaveBeenCalledTimes(1)
		expect(timers).toHaveLength(0)
	})
})

describe('a new worker client resets the gate', () => {
	it('a load for the new client is not covered by a load of the old client, and the interval does not hold it back', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		const old = controlled()
		const oldRun = gate.request('historyEoa_change', old.load)
		gate.reset()
		const fresh = jest.fn(async () => undefined)
		await gate.request('listen_start', fresh)
		expect(fresh).toHaveBeenCalledTimes(1)
		// The old load finishes after the reset: it does not change the state of the new client.
		old.resolve()
		await oldRun
		await flush()
		expect(gate.state()).toEqual({ inFlight: false, dirty: false, lastDoneAt: expect.any(Number), trailing: false })
	})

	it('after a reset the first ordinary request runs at once (no interval from the old client)', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		gate.reset()
		const again = jest.fn(async () => undefined)
		await gate.request('other', again)
		expect(again).toHaveBeenCalledTimes(1)
	})
})

describe('a skipped request whose timer fires during a load is not dropped', () => {
	it('the trailing request runs after the load in flight, as the dirty re-run, once the interval has passed again', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 1_000
		const skipped = jest.fn(async () => undefined)
		await gate.request('other', skipped)
		expect(timers).toHaveLength(1)
		// A bypass load starts (it is not held back by the interval) and is still running when the timer fires.
		const bypass = controlled()
		void gate.request('foreground_resume', bypass.load)
		clock += timers[0].ms
		const fire = timers[0].fn
		timers = []
		fire()
		expect(skipped).not.toHaveBeenCalled()
		// The load ends: the skipped request runs again, but the interval counts from this end, so it waits and is scheduled again.
		bypass.resolve()
		await flush()
		expect(skipped).not.toHaveBeenCalled()
		expect(timers).toHaveLength(1)
		expect(timers[0].ms).toBe(HISTORY_LOAD_MIN_INTERVAL_MS)
		clock += timers[0].ms
		const again = timers[0].fn
		timers = []
		again()
		await flush()
		expect(skipped).toHaveBeenCalledTimes(1)
	})

	it('a stronger bypass request during that dirty wait keeps its own load for the re-run', async () => {
		const gate = createHistoryLoadGate({ now, log, schedule })
		await gate.request('listen_start', async () => undefined)
		clock += 1_000
		await gate.request('other', async () => undefined)
		const bypass = controlled()
		void gate.request('foreground_resume', bypass.load)
		clock += timers[0].ms
		const fire = timers[0].fn
		timers = []
		fire()
		// A different bypass reason arrives during the same load: its load is the one the re-run uses.
		const second = jest.fn(async () => undefined)
		void gate.request('historyEoa_change', second)
		bypass.resolve()
		await flush()
		expect(second).toHaveBeenCalledTimes(1)
	})
})

