/**
 * the store commit gates every ACK, dropped lines never reach a native `ackInbound`, and browser markers are
 * written with the commit and rolled back when it fails.
 */
import { settleInboundBatch, type InboundAckTarget, type InboundBatchSettleDeps } from './inboundBatchSettle'
import { durablePendingCount, resetDurablePendingForTest, type DurableMirror } from './inboundDurable'
import { newInboundLists, recordDroppedLine, recordInboundLine, classifyInboundLine, settleInputOf, routeArrivedLine, unparseableDropLogLine } from './inboundRowRecord'
import { issueInboundAck } from './inboundBatchSettle'

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

type Opts = {
	browser: boolean
	/** Resolves the commit. Default: true. */
	commit?: () => Promise<boolean>
	lineHash: Record<string, string>
	/** Native: hashes that already had an `ackInbound` in this page session. */
	acked?: Set<string>
}

function harness(opts: Opts) {
	/** Order of the effects, for "before/after" checks. */
	const log: string[] = []
	/** Markers in memory (the store object). */
	const memory = new Set<string>()
	/** Markers that a successful commit has written. */
	const persisted = new Set<string>()
	const mailbox: string[][] = []
	const displayed: string[][] = []
	const acked = opts.acked ?? new Set<string>()
	const target: InboundAckTarget = {
		browser: opts.browser,
		alreadyAcked: (h) => acked.has(h),
		ackMailbox: (hashes) => {
			log.push('ackMailbox')
			mailbox.push(hashes)
		},
		// The target records an ACK only when the call is made (issueInboundAck); here the call is always made.
		ackDisplayed: (hashes) => {
			log.push('ackDisplayed')
			displayed.push(hashes)
			hashes.forEach((h) => acked.add(h))
		},
	}
	// like the page: `release` (releaseInboundLines) removes the line from the pending map and `hashesOf` (inboundArmorHashesOf) reads what is still pending, so a lookup made after the release answers nothing
	const released = new Set<string>()
	const deps: InboundBatchSettleDeps = {
		target,
		hashesOf: (lines) => lines.filter((l) => !released.has(l)).map((l) => opts.lineHash[l]).filter((h): h is string => !!h),
		markHashes: (hashes) => {
			log.push(`mark:${hashes.join(',')}`)
			const added = hashes.filter((h) => !memory.has(h))
			added.forEach((h) => memory.add(h))
			return added
		},
		unmarkHashes: (hashes) => {
			log.push(`unmark:${hashes.join(',')}`)
			hashes.forEach((h) => memory.delete(h))
		},
		commit: async () => {
			log.push('commit')
			const ok = await (opts.commit ? opts.commit() : Promise.resolve(true))
			if (ok) memory.forEach((h) => persisted.add(h))
			return ok
		},
		release: (lines) => {
			log.push(`release:${lines.join(',')}`)
			lines.forEach((l) => released.add(l))
		},
	}
	return { log, memory, persisted, mailbox, displayed, deps, acked }
}

describe('settleInboundBatch', () => {
	it('store failure sends no ACK of any kind (browser), rolls back its markers, and keeps the pending lines', async () => {
		const h = harness({ browser: true, commit: async () => false, lineHash: { chat: H(1), ctl: H(2) } })
		const ok = await settleInboundBatch({ rowLines: ['chat'], dropLines: ['ctl'] }, h.deps)
		expect(ok).toBe(false)
		expect(h.mailbox).toEqual([])
		expect(h.displayed).toEqual([])
		expect(h.log).not.toContain('release:chat,ctl')
		expect(h.memory.size).toBe(0)
		expect(h.persisted.size).toBe(0)
	})

	it('store failure sends no ackInbound (native), and no marker is written', async () => {
		const h = harness({ browser: false, commit: async () => false, lineHash: { chat: H(3) } })
		const ok = await settleInboundBatch({ rowLines: ['chat'], dropLines: [] }, h.deps)
		expect(ok).toBe(false)
		expect(h.displayed).toEqual([])
		expect(h.log.some((e) => e.startsWith('mark:'))).toBe(false)
	})

	it('browser: the mailbox ACK is sent only after the commit has resolved true', async () => {
		let finish: (ok: boolean) => void = () => undefined
		const pending = new Promise<boolean>((resolve) => {
			finish = resolve
		})
		const h = harness({ browser: true, commit: () => pending, lineHash: { chat: H(4) } })
		const run = settleInboundBatch({ rowLines: [], dropLines: ['chat'] }, h.deps) // a dropped line: the only kind this step ACKs in the browser
		await new Promise((r) => setTimeout(r, 0))
		expect(h.mailbox).toEqual([])
		finish(true)
		await expect(run).resolves.toBe(true)
		expect(h.mailbox).toEqual([[H(4)]])
		expect(h.log.indexOf('ackMailbox')).toBeGreaterThan(h.log.indexOf('commit'))
	})

	it('native: a replayed non-chat line is never passed to ackInbound, and gets no sender receipt through the page', async () => {
		const h = harness({
			browser: false,
			lineHash: { chat: H(5), control: H(6), nonchat: H(7), broken: H(8) },
		})
		await settleInboundBatch({ rowLines: ['chat'], dropLines: ['control', 'nonchat', 'broken'] }, h.deps)
		expect(h.displayed).toEqual([[H(5)]])
		const acked = h.displayed.flat()
		expect(acked).not.toContain(H(6))
		expect(acked).not.toContain(H(7))
		expect(acked).not.toContain(H(8))
		// Native rows only: no marker is written in the native store.
		expect(h.memory.size).toBe(0)
		expect(h.mailbox).toEqual([])
	})

	it('native: a batch with no row sends no ackInbound at all', async () => {
		const h = harness({ browser: false, lineHash: { ctl: H(9) } })
		await settleInboundBatch({ rowLines: [], dropLines: ['ctl'] }, h.deps)
		expect(h.displayed).toEqual([])
	})

	it('browser discarded frame: its marker is written before the commit, and the ACK follows the commit; a message row of the same batch is neither marked nor ACKed here', async () => {
		const h = harness({ browser: true, lineHash: { chat: H(10), voice: H(11) } })
		await settleInboundBatch({ rowLines: ['chat'], dropLines: ['voice'] }, h.deps)
		const marks = h.log.findIndex((e) => e.startsWith('mark:'))
		const commit = h.log.indexOf('commit')
		const ack = h.log.indexOf('ackMailbox')
		expect(marks).toBeGreaterThanOrEqual(0)
		expect(marks).toBeLessThan(commit)
		expect(commit).toBeLessThan(ack)
		expect(h.persisted.has(H(11))).toBe(true)
		expect(h.persisted.has(H(10))).toBe(false)
		expect(h.mailbox).toEqual([[H(11)]])
	})

	it('browser discarded frame whose marker commit fails: no marker is kept and no ACK is sent', async () => {
		const h = harness({ browser: true, commit: async () => false, lineHash: { voice: H(12) } })
		await settleInboundBatch({ rowLines: [], dropLines: ['voice'] }, h.deps)
		expect(h.log).toContain(`unmark:${H(12)}`)
		expect(h.memory.has(H(12))).toBe(false)
		expect(h.persisted.has(H(12))).toBe(false)
		expect(h.mailbox).toEqual([])
	})

	it('a marker that was already there is not rolled back by a failed commit', async () => {
		const h = harness({ browser: true, commit: async () => false, lineHash: { voice: H(13) } })
		h.memory.add(H(13))
		await settleInboundBatch({ rowLines: [], dropLines: ['voice'] }, h.deps)
		expect(h.memory.has(H(13))).toBe(true)
		expect(h.log.some((e) => e.startsWith('unmark:'))).toBe(false)
	})

	it('native: a duplicate copy whose hash was never ACKed gets one ackInbound', async () => {
		const h = harness({ browser: false, lineHash: { row: H(20), dup: H(21) } })
		await settleInboundBatch({ rowLines: ['row'], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		expect(h.displayed).toEqual([[H(20), H(21)]])
		expect(h.acked.has(H(21))).toBe(true)
	})

	it('native: a duplicate copy whose hash was already ACKed gets no ackInbound', async () => {
		const h = harness({ browser: false, lineHash: { dup: H(22) }, acked: new Set([H(22)]) })
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		expect(h.displayed).toEqual([])
	})

	it('native: the same duplicate in a later batch is not ACKed a second time', async () => {
		const h = harness({ browser: false, lineHash: { dup: H(23) } })
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		expect(h.displayed).toEqual([[H(23)]])
	})

	it('browser: a duplicate copy with no append to wait for is neither marked nor ACKed (the mailbox sends it again)', async () => {
		const h = harness({ browser: true, lineHash: { dup: H(24) } })
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		expect(h.log.some((e) => e.startsWith('mark:'))).toBe(false)
		expect(h.log).not.toContain('ackMailbox')
		expect(h.mailbox).toEqual([])
	})

	/**
	 * One batch the way the page takes it: App.tsx processQueue routes each arrived line with routeArrivedLine (a handled line goes to the replay branch, not modelled here),
	 * and addNewMessage records an unparseable one as dropped and a chat line as a row with its append, then runs ONE settle step. App.tsx's wiring of these calls is held by the static tests.
	 */
	async function pageBatch(h: ReturnType<typeof harness>, raws: string[], appends: Record<string, DurableMirror> = {}) {
		const lists = newInboundLists()
		const routes: string[] = []
		const rows: string[] = []
		for (const raw of raws) {
			const isMessage = !!appends[raw]
			const route = routeArrivedLine(raw, { key: isMessage ? appends[raw]!.sendId : null, marked: false, seen: false })
			routes.push(route)
			if (route === 'already_handled') continue
			if (classifyInboundLine(raw).kind === 'unparseable') { recordDroppedLine(lists, raw); continue }
			recordInboundLine(lists, raw, true, { mirror: () => appends[raw], write: () => { rows.push(raw) } })
		}
		await settleInboundBatch(settleInputOf(lists), { ...h.deps, durableOptions: { waitMs: 1000, backoffMs: [1] } })
		return { routes, rows }
	}
	const GARBAGE = '{"text": not json'
	const MESSAGE = JSON.stringify({ text: 't', signMessage: '0x12', from: '0xa', timestamp: 1 })
	const tick = () => new Promise((r) => setTimeout(r, 15))
	/** an append whose remote commit fails until `open()`: the page's wait keeps asking */
	const remoteAppend = (sendId: string) => {
		let ok = false
		let asked = 0
		const attempt = async () => { asked += 1; return ok }
		return { mirror: { done: attempt(), retry: attempt, sendId, failure: () => 'pointer' as const } satisfies DurableMirror, open: () => { ok = true }, asked: () => asked }
	}

	it('browser: a frame that does not parse is dropped and ACKed on its FIRST arrival (marker, commit, ACK), with no row', async () => {
		resetDurablePendingForTest()
		const h = harness({ browser: true, lineHash: { [GARBAGE]: H(25) } })
		const r = await pageBatch(h, [GARBAGE])
		expect(r.routes).toEqual(['drop_unparseable'])
		expect(r.rows).toEqual([])
		expect(h.log).toEqual([`mark:${H(25)}`, 'commit', `release:${GARBAGE}`, 'ackMailbox'])
		expect(h.mailbox).toEqual([[H(25)]])
		expect(h.persisted.has(H(25))).toBe(true)
	})

	it('browser: a redelivery of that frame (now marked) takes the same route, is ACKed again and processes nothing', async () => {
		resetDurablePendingForTest()
		expect(routeArrivedLine(GARBAGE, { key: null, marked: true, seen: false })).toBe('drop_unparseable')
		const mailbox: string[][] = []
		for (let i = 0; i < 2; i++) {
			const h = harness({ browser: true, lineHash: { [GARBAGE]: H(25) } }) // a new delivery: the pending map has the line again
			const r = await pageBatch(h, [GARBAGE])
			expect(r.rows).toEqual([])
			mailbox.push(...h.mailbox)
		}
		expect(mailbox).toEqual([[H(25)], [H(25)]])
		expect(durablePendingCount()).toBe(0) // no append was ever started
	})

	it('browser: a dropped frame that shares its armor hash with a message row is not marked and not ACKed early: the hash is ACKed only by the row\'s wait, after the remote commit', async () => {
		resetDurablePendingForTest()
		const h = harness({ browser: true, lineHash: { [GARBAGE]: H(30), [MESSAGE]: H(30) } })
		const a = remoteAppend('s-shared')
		await pageBatch(h, [GARBAGE, MESSAGE], { [MESSAGE]: a.mirror })
		await tick()
		expect(h.mailbox).toEqual([])
		expect(h.log.some((e) => e.startsWith('mark:'))).toBe(false)
		a.open()
		await tick()
		expect(h.mailbox).toEqual([[H(30)]])
	})

	it('browser: in the same batch the dropped frame is ACKed at once and the message row still waits for the remote commit', async () => {
		resetDurablePendingForTest()
		const h = harness({ browser: true, lineHash: { [GARBAGE]: H(25), [MESSAGE]: H(31) } })
		const a = remoteAppend('s-row')
		const r = await pageBatch(h, [GARBAGE, MESSAGE], { [MESSAGE]: a.mirror })
		await tick()
		expect(r.rows).toEqual([MESSAGE])
		expect(h.mailbox).toEqual([[H(25)]])
		expect(a.asked()).toBeGreaterThan(1) // the remote commit failed and is asked again; still no ACK
		expect(h.persisted.has(H(31))).toBe(false)
		a.open()
		await tick()
		expect(h.mailbox).toEqual([[H(25)], [H(31)]])
	})

	it('scope: only frames that do not parse. JSON without a message key, and JSON that is not a signed line, keep the previous route; a keyed, marked or seen chat line too', () => {
		const keyless = JSON.stringify({ text: 't', signMessage: '0x12' })
		expect(routeArrivedLine(keyless, { key: null, marked: false, seen: false })).toBe('already_handled')
		expect(routeArrivedLine('{"a":1}', { key: null, marked: false, seen: false })).toBe('already_handled')
		expect(routeArrivedLine('42', { key: null, marked: false, seen: false })).toBe('already_handled')
		expect(routeArrivedLine(MESSAGE, { key: '0xa_1', marked: false, seen: false })).toBe('fresh')
		expect(routeArrivedLine(MESSAGE, { key: '0xa_1', marked: true, seen: false })).toBe('already_handled')
		expect(routeArrivedLine(MESSAGE, { key: '0xa_1', marked: false, seen: true })).toBe('already_handled')
		expect(routeArrivedLine('null', { key: null, marked: false, seen: false })).toBe('drop_unparseable')
		expect(routeArrivedLine('   ', { key: null, marked: false, seen: false })).toBe('drop_unparseable')
	})

	it('log: a count and the last 8 hex digits of each armor hash, never the text or a whole hash', () => {
		const line = unparseableDropLogLine(2, [H(0xabc), `0x${'1'.repeat(56)}DEADBEEF`])
		expect(line).toContain('2 frame(s)')
		expect(line).toContain('hash tails: 00000abc,deadbeef')
		expect(line).not.toMatch(/[0-9a-f]{9}/i)
	})

	it('native: an unparseable line is never ACKed', async () => {
		const raw = 'not json'
		const h = harness({ browser: false, lineHash: { [raw]: H(26) } })
		await settleInboundBatch({ rowLines: [], dropLines: [raw] }, h.deps)
		expect(h.displayed).toEqual([])
		expect(h.log.some((e) => e.startsWith('mark:'))).toBe(false)
	})

	it('native: a client that is absent records nothing, so the next copy is ACKed (issueInboundAck)', async () => {
		const acked = new Set<string>()
		const sent: string[][] = []
		const target: InboundAckTarget = {
			browser: false,
			alreadyAcked: (h) => acked.has(h),
			ackMailbox: () => undefined,
			// No client: the call is not made, so nothing is recorded.
			ackDisplayed: (hashes) => void issueInboundAck(null, hashes, (h) => acked.add(h)),
		}
		const hashByLine: Record<string, string> = { dup: H(40) }
		const deps: InboundBatchSettleDeps = {
			target,
			hashesOf: (lines) => lines.map((l) => hashByLine[l]).filter((h): h is string => !!h),
			markHashes: () => [],
			unmarkHashes: () => undefined,
			commit: async () => true,
			release: () => undefined,
		}
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, deps)
		expect(acked.has(H(40))).toBe(false)
		// A later copy is still ACKed, once a client exists.
		const withClient: InboundAckTarget = {
			...target,
			ackDisplayed: (hashes) => void issueInboundAck((h) => sent.push(h), hashes, (h) => acked.add(h)),
		}
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, { ...deps, target: withClient })
		expect(sent).toEqual([[H(40)]])
		expect(acked.has(H(40))).toBe(true)
	})
})

describe('issueInboundAck ', () => {
	it('no client: returns false and records nothing', () => {
		const recorded: string[] = []
		expect(issueInboundAck(null, [H(41)], (h) => recorded.push(h))).toBe(false)
		expect(recorded).toEqual([])
	})

	it('a call that throws: returns false and records nothing', () => {
		const recorded: string[] = []
		expect(
			issueInboundAck(
				() => {
					throw new Error('bridge gone')
				},
				[H(42)],
				(h) => recorded.push(h),
			),
		).toBe(false)
		expect(recorded).toEqual([])
	})

	it('a call that is made: returns true and records each hash', () => {
		const recorded: string[] = []
		const sent: string[][] = []
		expect(issueInboundAck((h) => sent.push(h), [H(43), H(44)], (h) => recorded.push(h))).toBe(true)
		expect(sent).toEqual([[H(43), H(44)]])
		expect(recorded).toEqual([H(43), H(44)])
	})

	it('an empty list is not a call', () => {
		expect(issueInboundAck((() => undefined), [], () => undefined)).toBe(false)
	})
})
