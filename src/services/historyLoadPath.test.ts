/**
 * the bridge's history load path, run at run time. The path is the part of chatWorkerBridge.ts that does not need the worker:
 * the queue before the client is ready, the merge of queued requests, the flush, the gate, and the buffer count before the forward.
 * The bridge itself is still checked by source (historyLoadWiring.static.test.ts), because it imports the worker. SYNTHETIC values only.
 */
import { createHistoryLoadPath } from './historyLoadPath'
import { createHistoryLoadGate } from './historyLoadGate'

type Opts = { tailCount?: number }

/** A gate with a fake clock and a captured log; the runLoad calls are recorded in order. */
function setup(opts: { runLoad?: (o?: Opts) => Promise<void> } = {}) {
	let clock = 1_000_000
	const lines: string[] = []
	const gate = createHistoryLoadGate({ now: () => clock, log: (l) => lines.push(l) })
	const calls: Array<Opts | undefined> = []
	const queuedNotes: number[] = []
	const path = createHistoryLoadPath<Opts>({
		gate,
		runLoad: async (o) => {
			calls.push(o)
			if (opts.runLoad) await opts.runLoad(o)
		},
		onQueued: () => queuedNotes.push(1),
	})
	return {
		path,
		calls,
		lines,
		queuedNotes,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

describe('before the worker client is ready', () => {
	it('a request is queued, nothing runs, and the queue note is raised once per request', async () => {
		const t = setup()
		await t.path.load(undefined, 'other', false)
		expect(t.calls).toEqual([])
		expect(t.path.pending()).toEqual({ caller: 'other', hasOptions: false })
		expect(t.queuedNotes).toHaveLength(1)
	})

	it('the first ready request flushes the queue exactly once and clears it', async () => {
		const t = setup()
		await t.path.load(undefined, 'other', false)
		await t.path.load(undefined, 'listen_start', true)
		expect(t.calls).toHaveLength(1)
		expect(t.path.pending()).toBeNull()
		// A later ready request does not run the old queue again: the queue is empty.
		t.advance(60_000)
		await t.path.load(undefined, 'listen_start', true)
		expect(t.calls).toHaveLength(2)
	})

	it('queued options are kept when the flushing request gives none; explicit options win when given', async () => {
		const t = setup()
		await t.path.load({ tailCount: 5 }, 'other', false)
		await t.path.load(undefined, 'other', false)
		expect(t.path.pending()).toEqual({ caller: 'other', hasOptions: true })
		await t.path.load(undefined, 'other', true)
		expect(t.calls[0]).toEqual({ tailCount: 5 })

		const u = setup()
		await u.path.load({ tailCount: 5 }, 'other', false)
		await u.path.load({ tailCount: 9 }, 'other', true)
		expect(u.calls[0]).toEqual({ tailCount: 9 })
	})

	it('a bypass caller is not hidden by an ordinary one queued before it: the flush runs as historyEoa_change', async () => {
		const t = setup()
		await t.path.load(undefined, 'other', false)
		await t.path.load(undefined, 'historyEoa_change', false)
		expect(t.path.pending()).toEqual({ caller: 'historyEoa_change', hasOptions: false })
		await t.path.load(undefined, 'listen_start', true)
		expect(t.lines.some((l) => l.startsWith('[history] load caller=historyEoa_change '))).toBe(true)
	})

	it('a later ordinary request does not downgrade a queued account change', async () => {
		const t = setup()
		await t.path.load(undefined, 'historyEoa_change', false)
		await t.path.load(undefined, 'other', false)
		expect(t.path.pending()?.caller).toBe('historyEoa_change')
	})
})

describe('when ready: the gate decides (single-flight and interval through the path)', () => {
	it('a ready request with nothing queued runs at once', async () => {
		const t = setup()
		await t.path.load(undefined, 'listen_start', true)
		expect(t.calls).toHaveLength(1)
	})

	it('two concurrent ready requests of the same reason run the SDK load once (single-flight)', async () => {
		let release: (() => void) | undefined
		const t = setup({
			runLoad: () =>
				new Promise<void>((r) => {
					release = () => r()
				}),
		})
		const a = t.path.load(undefined, 'other', true)
		const b = t.path.load(undefined, 'other', true)
		expect(t.calls).toHaveLength(1)
		release?.()
		await Promise.all([a, b])
		expect(t.calls).toHaveLength(1)
	})

	it('an ordinary request within the interval after a load is skipped; a foreground resume runs', async () => {
		const t = setup()
		await t.path.load(undefined, 'listen_start', true)
		t.advance(1_000)
		await t.path.load(undefined, 'other', true)
		expect(t.calls).toHaveLength(1)
		expect(t.lines.some((l) => l.includes('skip caller=other reason=interval'))).toBe(true)
		await t.path.load(undefined, 'foreground_resume', true)
		expect(t.calls).toHaveLength(2)
	})

	it('a queued ordinary request that flushes inside the interval is skipped by the gate, numbers only in the log', async () => {
		const t = setup()
		await t.path.load(undefined, 'listen_start', true)
		t.advance(5_000)
		await t.path.load(undefined, 'other', false)
		await t.path.load(undefined, 'other', true)
		expect(t.calls).toHaveLength(1)
		expect(t.lines.join('\n')).not.toMatch(/0x[0-9a-fA-F]{40}/)
	})
})

describe('the buffer deliveries (count, then forward the same batch)', () => {
	it('the entries are counted in the load line, and the batch object reaches the forward unchanged', async () => {
		const forwarded: unknown[] = []
		const t = setup({
			runLoad: async () => {
				t.path.deliverBuffer({ entries: [1, 2, 3] }, (b) => forwarded.push(b))
			},
		})
		const batch = { entries: [1, 2, 3] as unknown[] }
		t.path.deliverBuffer(batch, (b) => forwarded.push(b))
		expect(forwarded[0]).toBe(batch)
		await t.path.load(undefined, 'listen_start', true)
		expect(t.lines.find((l) => l.startsWith('[history] load '))).toMatch(/ delivered=3$/)
		expect(forwarded).toHaveLength(2)
	})

	it('a batch without entries is forwarded and counts zero; a batch outside a load is not counted', async () => {
		const forwarded: unknown[] = []
		const t = setup({
			runLoad: async () => {
				t.path.deliverBuffer(undefined, (b) => forwarded.push(b))
				t.path.deliverBuffer({ entries: 'not-a-list' as unknown as unknown[] }, (b) => forwarded.push(b))
			},
		})
		t.path.deliverBuffer({ entries: [9, 9] }, (b) => forwarded.push(b))
		await t.path.load(undefined, 'listen_start', true)
		expect(forwarded).toHaveLength(3)
		expect(t.lines.find((l) => l.startsWith('[history] load '))).toMatch(/ delivered=0$/)
	})
})

describe('a failing SDK load does not leave the path stuck', () => {
	it('the gate finishes the load, logs it, and a later bypass request still runs', async () => {
		const t = setup({
			runLoad: async () => {
				throw new Error('synthetic sdk failure')
			},
		})
		await expect(t.path.load(undefined, 'listen_start', true)).resolves.toBeUndefined()
		expect(t.lines.some((l) => l.startsWith('[history] load caller=listen_start '))).toBe(true)
		await t.path.load(undefined, 'historyEoa_change', true)
		expect(t.calls).toHaveLength(2)
	})
})
