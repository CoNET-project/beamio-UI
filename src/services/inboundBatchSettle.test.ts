/**
 * the store commit gates every ACK, dropped lines never reach a native `ackInbound`, and browser markers are
 * written with the commit and rolled back when it fails.
 */
import { settleInboundBatch, type InboundAckTarget, type InboundBatchSettleDeps } from './inboundBatchSettle'
import { parseInboundLine } from './inboundRowRecord'
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
	const deps: InboundBatchSettleDeps = {
		target,
		hashesOf: (lines) => lines.map((l) => opts.lineHash[l]).filter((h): h is string => !!h),
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
		const run = settleInboundBatch({ rowLines: ['chat'], dropLines: [] }, h.deps)
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

	it('browser discarded frame: its marker is written before the commit, and the ACK follows the commit', async () => {
		const h = harness({ browser: true, lineHash: { chat: H(10), voice: H(11) } })
		await settleInboundBatch({ rowLines: ['chat'], dropLines: ['voice'] }, h.deps)
		const marks = h.log.findIndex((e) => e.startsWith('mark:'))
		const commit = h.log.indexOf('commit')
		const ack = h.log.indexOf('ackMailbox')
		expect(marks).toBeGreaterThanOrEqual(0)
		expect(marks).toBeLessThan(commit)
		expect(commit).toBeLessThan(ack)
		expect(h.persisted.has(H(11))).toBe(true)
		expect(h.mailbox).toEqual([[H(10), H(11)]])
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

	it('browser: a duplicate copy is marked and ACKed after the commit, as before ', async () => {
		const h = harness({ browser: true, lineHash: { dup: H(24) } })
		await settleInboundBatch({ rowLines: [], duplicateLines: ['dup'], dropLines: [] }, h.deps)
		expect(h.log.indexOf(`mark:${H(24)}`)).toBeLessThan(h.log.indexOf('commit'))
		expect(h.log.indexOf('commit')).toBeLessThan(h.log.indexOf('ackMailbox'))
		expect(h.mailbox).toEqual([[H(24)]])
	})

	it('browser: an unparseable line is a dropped frame: marker before the commit, ACK after it', async () => {
		const raw = '{"text": not json'
		expect(parseInboundLine(raw)).toBeNull()
		const h = harness({ browser: true, lineHash: { [raw]: H(25) } })
		await settleInboundBatch({ rowLines: [], dropLines: [raw] }, h.deps)
		expect(h.log.indexOf(`mark:${H(25)}`)).toBeLessThan(h.log.indexOf('commit'))
		expect(h.log.indexOf('commit')).toBeLessThan(h.log.indexOf('ackMailbox'))
		expect(h.persisted.has(H(25))).toBe(true)
		expect(h.mailbox).toEqual([[H(25)]])
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
