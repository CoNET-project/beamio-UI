/**
 * @jest-environment node
 *
 *
 * SIMULATION, labelled as such: the REAL settle step, the REAL wait (inboundDurable.ts) and the REAL row recording run against a MODELLED mailbox (keeps a line until ACK, sends everything again at each listen, like
 * keeps an un-ACKed line, removes it on the ACK), a MODELLED worker history (durable across a kill, dedupes by sendId, may be cut short between the index record and the library row, like worker/history.ts append +
 * ensureLibraryRow) and a MODELLED page process (a kill drops its in-memory state and every in-flight append; no page-exit event exists in the model). It proves the ordering logic; it is not a browser run.
 * The deterministic browser-level coverage is the diagnostic build ("diagnostic package"); the formal package is covered probabilistically.
 */
import { settleInboundBatch } from './inboundBatchSettle'
import { durableStats, remoteUnsentInboundSendIds, resetDurablePendingForTest, unsavedInboundSendIds, type DurableMirror } from './inboundDurable'
import { appendFailureCodeOf, type AppendFailureCode } from './historyAppendAck'
import { newInboundLists, recordDroppedLine, recordInboundLine, settleInputOf } from './inboundRowRecord'

const hashOf = (line: string): string => `0x${Buffer.from(line).toString('hex').padEnd(64, '0').slice(0, 64)}`
const sendIdOf = (line: string): string => line.split('|')[0] as string
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** the mailbox: a line stays until its hash is ACKed; every listen sends the whole set again */
class Mailbox {
	lines = new Map<string, string>()
	put(line: string): void { this.lines.set(hashOf(line), line) }
	listen(): string[] { return [...this.lines.values()] }
	acked: string[] = []
	ack(hash: string): void { this.lines.delete(hash); this.acked.push(hash); this.onAck?.(hash) }
	onAck?: (hash: string) => void
}

/** the worker history: survives a kill. `cutShort` leaves the index record and no library row (the half-way append) */
class History {
	records = new Set<string>() // the index (sendIds)
	rows = new Map<string, string>() // the library
	appends = 0
	mode: 'ok' | 'fail' | 'cut_short_once' | 'row_write_fails_silently_once' = 'ok'
	// the remote commit of an INBOUND record (fragment, index, pointer). While it is down the append saves the local copy (record + row), keeps a durable pending record and REJECTS remote_commit_failed:pointer;
	// the same sendId appended again resumes it (idempotent: no second record, no second row). `log` is the order of the durable events and of the mailbox ACKs.
	remoteDown = false
	remotePending = new Set<string>()
	remoteCommitted = new Set<string>()
	log: string[] = []
	lastFailure = new Map<string, AppendFailureCode>()
	failureOf(sendId: string): AppendFailureCode | undefined { return this.lastFailure.get(sendId) }
	async append(sendId: string, body: string, alive: () => boolean): Promise<void> {
		try {
			await this.appendLocal(sendId, body, alive)
			if (!alive()) return new Promise<void>(() => undefined)
			if (this.remoteCommitted.has(sendId)) { this.lastFailure.delete(sendId); return }
			this.remotePending.add(sendId)
			if (this.remoteDown) throw new Error('remote_commit_failed:pointer')
			this.remotePending.delete(sendId)
			this.remoteCommitted.add(sendId)
			this.log.push(`commit:${sendId}`)
			this.lastFailure.delete(sendId)
		} catch (ex) {
			this.lastFailure.set(sendId, appendFailureCodeOf((ex as Error).message))
			throw ex
		}
	}
	async appendLocal(sendId: string, body: string, alive: () => boolean): Promise<void> {
		this.appends += 1
		await wait(2)
		if (!alive()) return new Promise<void>(() => undefined) // the process is gone: the answer never comes
		if (this.mode === 'fail') throw new Error('worker not ready')
		if (!this.records.has(sendId)) {
			this.records.add(sendId)
			if (this.mode === 'cut_short_once') { this.mode = 'ok'; throw new Error('killed between the index record and the library row') }
			// the append of: the library write fails, the error is swallowed, the append RESOLVES with the index record written and no library row
			if (this.mode === 'row_write_fails_silently_once') { this.mode = 'ok'; return }
		}
		// ensureLibraryRow: the library row is completed even when the sendId is already indexed (idempotent: one row per sendId)
		this.rows.set(sendId, body)
	}
}

/** the account record on disk: the dedupe markers a store commit carried to disk (survive a kill) */
class Disk { markers = new Set<string>(); bodies = new Set<string>() /* the message bodies the committed account record holds */ }

/** one page process */
const livePages: Page[] = [] // every page of a test: killed after it, so an assertion that fails cannot leave a retry loop running (the run would not end)
class Page {
	alive = true
	seen = new Set<string>() // the page's own dedupe memory: lost with the process
	recordKeepsBodies = true // what libraryPersistModeFor says at the commit: false = library / guarded (the record keeps no body)
	modeAtMirror: 'record' | 'library' = 'library' // the mode read when the row was recorded (decides whether an append is started in the OLD wiring)
	oldWiring = false // control wiring: the append is started only when the mode read at that moment is library / guarded
	pendingRows: string[] = []
	released = new Set<string>()
	mem: Set<string> // the markers in the page's store object: written to disk only by a commit
	constructor(private mb: Mailbox, private hist: History, private library: boolean, private backoff: number = 3, private disk: Disk = new Disk()) { this.mem = new Set(disk.markers); this.recordKeepsBodies = !library; livePages.push(this) }
	kill(): void { this.alive = false; resetDurablePendingForTest() } // SIGKILL: no handler runs, memory is gone, in-flight appends never answer
	async receive(lines: string[]): Promise<void> {
		const lists = newInboundLists()
		const replays: string[] = []
		for (const line of lines) {
			// App.tsx isInboundLineMarked: a line whose marker is in the store is "already handled": it is ACKed again without a new append
			if (this.mem.has(hashOf(line))) { replays.push(line); continue }
			const isNew = !this.seen.has(line)
			this.seen.add(line)
			recordInboundLine(lists, line, isNew, {
				mirror: isNew && this.library && (!this.oldWiring || this.modeAtMirror === 'library')
					? () => {
						const attempt = (): Promise<boolean> => this.hist.append(sendIdOf(line), line, () => this.alive).then(() => true, () => false)
						return { done: attempt(), retry: attempt, sendId: sendIdOf(line), failure: () => this.hist.failureOf(sendIdOf(line)) } as DurableMirror
					}
					: undefined,
				write: () => undefined, // the row is on the page (displayed) from here on
			})
		}
		if (replays.length) for (const l of replays) recordDroppedLine(lists, l)
		this.pendingRows = [...lists.stored]
		await settleInboundBatch(settleInputOf(lists), {
			target: { browser: true, alreadyAcked: () => false, ackMailbox: (hs) => { if (this.alive) hs.forEach((h) => this.mb.ack(h)) }, ackDisplayed: () => undefined },
			// like the page: `release` removes the line from the pending map and `hashesOf` reads what is still pending
			hashesOf: (ls) => ls.filter((l) => !this.released.has(l)).map(hashOf),
			markHashes: (hs) => { const added = hs.filter((h) => !this.mem.has(h)); added.forEach((h) => this.mem.add(h)); return added },
			unmarkHashes: (hs) => { hs.forEach((h) => this.mem.delete(h)) },
			commit: async () => { if (this.alive) { this.mem.forEach((h) => this.disk.markers.add(h)); if (this.recordKeepsBodies) this.pendingRows.forEach((l) => this.disk.bodies.add(l)) } return true }, // the store write: the markers in memory reach the disk; the bodies only when the record keeps them (record mode)
			release: (ls) => { ls.forEach((l) => this.released.add(l)) },
			durableOptions: { sleep: () => wait(this.backoff), waitMs: 40, backoffMs: [this.backoff], alive: () => this.alive },
		})
	}
}

const L = (n: number): string => `send-${n}|synthetic`

beforeEach(() => resetDurablePendingForTest())
afterEach(() => { while (livePages.length) (livePages.pop() as Page).alive = false })

describe('SIGKILL and power loss: a message shown but not yet ACKed, or whose append is half way, is not lost and not doubled', () => {
	it('moment 1 (shown, ACK not sent): killed while the append is in flight -> the mailbox still holds the line -> the next process gets it again -> one library row, mailbox empty', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(1))
		const p1 = new Page(mb, hist, true)
		await p1.receive(mb.listen())
		p1.kill() // before the append answers
		await wait(15)
		expect(mb.lines.size).toBe(1) // never ACKed: the un-ACKed line IS the durable copy
		expect(hist.rows.size).toBe(0)
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen()) // the redelivery at the next listen
		await wait(20)
		expect([hist.rows.size, mb.lines.size]).toEqual([1, 0])
	})

	it('moment 2 (append half way): the index record exists and the library row does not; killed -> redelivery -> the retried append completes the row (no second record) -> ACK after that', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(2))
		hist.mode = 'cut_short_once'
		const p1 = new Page(mb, hist, true, 1000) // a long back-off: the page would retry later, but it is killed first
		await p1.receive(mb.listen())
		await wait(15) // the cut-short append failed: no ACK
		p1.kill()
		expect(hist.records.has('send-2')).toBe(true)
		expect(hist.rows.size).toBe(0)
		expect(mb.lines.size).toBe(1)
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.records.size, hist.rows.size, mb.lines.size]).toEqual([1, 1, 0])
	})

	it('the same cut-short append inside ONE live process: the page retries after a back-off and ACKs only then (no kill, no redelivery needed)', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(3))
		hist.mode = 'cut_short_once'
		const p = new Page(mb, hist, true)
		await p.receive(mb.listen())
		expect(mb.lines.size).toBe(1)
		await wait(40)
		expect([hist.rows.size, mb.lines.size, durableStats().failures]).toEqual([1, 0, 1])
		p.kill()
	})

	it('a row with NO append to wait for (the mirror returned nothing) is never ACKed: after the kill the mailbox still holds the line (the old behaviour ACKed it right after the commit and LOST it)', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(4))
		const p1 = new Page(mb, hist, false) // no append wait
		await p1.receive(mb.listen())
		p1.kill()
		await wait(15)
		expect(mb.lines.size).toBe(1) // the mailbox keeps it
		expect(hist.rows.size).toBe(0)
		const p2 = new Page(mb, hist, true) // the next page process, with an append
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, mb.lines.size]).toEqual([1, 0])
	})

	it('(the SDK rejects an append whose library row was not written): index record written, library write failed -> no ACK -> kill -> redelivery -> the row is written once, then ACK', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(7))
		hist.mode = 'cut_short_once' // what the SDK now does when the library write fails: the append rejects with the index record in place and the row missing
		const p1 = new Page(mb, hist, true, 1000)
		await p1.receive(mb.listen())
		await wait(15)
		expect([hist.records.has('send-7'), hist.rows.size, mb.lines.size]).toEqual([true, 0, 1]) // never ACKed
		p1.kill() // the strong kill right after the failed write
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.records.size, hist.rows.size, mb.lines.size]).toEqual([1, 1, 0]) // exactly once, then ACKed
	})

	it('control = behaviour (the SDK swallows the library write failure and resolves): index record written, row missing, ACK sent, kill -> the message is in the index but never in the library, and the mailbox no longer holds it', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(8))
		hist.mode = 'row_write_fails_silently_once'
		const p1 = new Page(mb, hist, true)
		await p1.receive(mb.listen())
		await wait(15)
		p1.kill()
		expect([hist.records.has('send-8'), hist.rows.size, mb.lines.size]).toEqual([true, 0, 0]) // ACKed with no library row: nothing will redeliver it, and no automatic sync rebuilds it
	})

	it('the row is committed (so the account record is on disk) while its append is in flight; killed; the redelivery is NOT taken as already handled: it reaches the append, one row, then ACK', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(20))
		const p1 = new Page(mb, hist, true, 3, disk)
		await p1.receive(mb.listen())
		p1.kill() // the commit ran (disk written) and the append never answered
		expect(disk.markers.size).toBe(0) // no marker for the waiting row reached the disk
		expect([hist.rows.size, mb.lines.size]).toEqual([0, 1])
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0])
		expect(disk.markers.size).toBe(0) // the marker of p2 is in memory until its next commit; the ACK has gone and the row is in the library
		expect(p2.mem.has(hashOf(L(20)))).toBe(true)
	})

	it('control = (marker committed before the append is confirmed): the same kill leaves a marker on disk, the redelivery is taken as handled and ACKed, the message is lost', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(21))
		const p1 = new Page(mb, hist, true, 3, disk)
		p1.mem.add(hashOf(L(21))) // what step 1 did for the waiting row before the commit
		disk.markers.add(hashOf(L(21))) // ... and what the commit carried to disk
		p1.kill()
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, mb.lines.size]).toEqual([0, 0]) // ACKed as "already handled", never appended
	})

	it('unsaved: the same message goes write fails -> retry fails -> hard refresh -> redelivery -> saved; it is marked unsaved while it is not saved, cleared by itself, and only ONE row and ONE index record remain', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(30))
		hist.mode = 'fail' // the library keeps refusing
		const p1 = new Page(mb, hist, true, 3, disk)
		await p1.receive(mb.listen())
		await wait(25) // the first attempt and at least one retry have failed
		expect(durableStats().failures).toBeGreaterThanOrEqual(2)
		expect(unsavedInboundSendIds().has('send-30')).toBe(true) // displayed, not saved: the chat says so
		expect([hist.rows.size, mb.lines.size]).toEqual([0, 1]) // no ACK while it is not saved
		p1.kill() // the hard refresh while it is still not saved
		expect(unsavedInboundSendIds().size).toBe(0) // the mark lived in the page: gone with it
		hist.mode = 'ok' // the library works again
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen()) // the mailbox sends the un-ACKed line again
		await wait(20)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0]) // one row, one index record, mailbox empty
		expect(unsavedInboundSendIds().size).toBe(0)
	})

	it('unsaved: write fails -> the page retries and it saves -> the mark clears by itself and the ACK follows (no refresh needed)', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(31))
		hist.mode = 'fail'
		const p = new Page(mb, hist, true, 4)
		await p.receive(mb.listen())
		await wait(10)
		expect(unsavedInboundSendIds().has('send-31')).toBe(true)
		hist.mode = 'ok'
		await wait(30)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0])
		expect(unsavedInboundSendIds().has('send-31')).toBe(false)
		p.kill()
	})

	it('the line comes AGAIN in the same session while its append is in flight (a replay batch), the process is killed, the redelivery is still appended (no marker reached the disk)', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(40))
		const p1 = new Page(mb, hist, true, 1000, disk)
		await p1.receive(mb.listen()) // first arrival: the append is in flight, the row is shown
		await p1.receive(mb.listen()) // the mailbox sends it again in the same session: the replay path, no durable map
		expect(disk.markers.size).toBe(0) // the replay's commit carried no marker for the pending hash
		p1.kill()
		expect([hist.rows.size, mb.lines.size]).toEqual([0, 1])
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0])
	})

	it('(new wiring): the row is recorded while the mode reads "record", the commit then keeps no body (library evidence arrived meanwhile): the ACK still waits for the append; killed -> redelivered -> one row', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(50))
		const p1 = new Page(mb, hist, true, 1000, disk)
		p1.modeAtMirror = 'record' // what the mode decision saw when the row was recorded
		p1.recordKeepsBodies = false // what the commit then did: no body in the record
		await p1.receive(mb.listen())
		await wait(15) // the append has answered (healthy) or not: either way the ACK follows the append, never the commit
		p1.kill() // a hard refresh
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0])
		expect(disk.bodies.size).toBe(0)
	})

	it('even with the old wiring (no append started because the mode read record when the row was recorded) the row is never ACKed after the commit: the mailbox keeps it, nothing is lost', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(51))
		const p1 = new Page(mb, hist, true, 3, disk)
		p1.oldWiring = true
		p1.modeAtMirror = 'record'
		p1.recordKeepsBodies = false
		await p1.receive(mb.listen())
		p1.kill()
		expect([hist.rows.size, disk.bodies.size]).toEqual([0, 0]) // no row in the library, no body in the record
		expect(mb.lines.size).toBe(1) // but the mailbox still holds the line: it is redelivered, not lost
	})

	it('root cause: the pending map is released at the commit, so the hashes must be taken BEFORE it; with the page-like release a row still gets its wait and its ACK follows the append, not the commit', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(53))
		const p = new Page(mb, hist, true, 1000)
		await p.receive(mb.listen())
		expect(mb.lines.size).toBe(1) // not ACKed right after the commit (about 0.1 s in the browser run)
		await wait(15) // the append answers
		expect([hist.rows.size, mb.lines.size]).toEqual([1, 0])
	})

	it('a record-mode account waits too: its row is ACKed only after its append (the committed record holds the body, but the next ordinary commit may strip it while the append is still queued)', async () => {
		const mb = new Mailbox(); const hist = new History(); const disk = new Disk()
		mb.put(L(52))
		const p1 = new Page(mb, hist, true, 1000, disk)
		p1.recordKeepsBodies = true // record mode at this commit
		await p1.receive(mb.listen())
		expect(mb.lines.size).toBe(1) // not ACKed after the commit
		// the evidence moves meanwhile: the next ordinary commit strips the body from the record, while the append is still in the worker queue; then a hard refresh
		disk.bodies.clear()
		p1.kill()
		expect(mb.lines.size).toBe(1) // the mailbox still holds the line
		const p2 = new Page(mb, hist, true, 3, disk)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([1, 1, 0])
	})

	it('power loss is the same as SIGKILL here: no handler of any kind is needed or run', async () => {
		const mb = new Mailbox(); const hist = new History()
		for (let i = 1; i <= 5; i++) mb.put(L(100 + i))
		const p1 = new Page(mb, hist, true)
		await p1.receive(mb.listen())
		p1.kill()
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(30)
		expect([hist.rows.size, mb.lines.size]).toEqual([5, 0])
	})

	it('an append that keeps failing in a live session: never ACKed, the failure count grows, the line stays in the mailbox; the next process (healthy worker) delivers it once', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(5))
		hist.mode = 'fail'
		const p1 = new Page(mb, hist, true)
		await p1.receive(mb.listen())
		await wait(60)
		expect(mb.lines.size).toBe(1)
		expect(durableStats().failures).toBeGreaterThanOrEqual(3)
		p1.kill()
		hist.mode = 'ok'
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.rows.size, mb.lines.size]).toEqual([1, 0])
	})

	it('a redelivery of a line that was already confirmed (its ACK was lost) is one row, not two, and is ACKed again', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(6))
		const p1 = new Page(mb, hist, true)
		await p1.receive(mb.listen())
		await wait(15)
		expect([hist.rows.size, mb.lines.size]).toEqual([1, 0])
		mb.put(L(6)) // the mailbox sends it again (as if the ACK had not arrived)
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(15)
		expect([hist.records.size, hist.rows.size, mb.lines.size]).toEqual([1, 1, 0])
		p1.kill(); p2.kill()
	})

	it('ten messages, the process is killed after seven were confirmed: after the redelivery there are exactly ten rows', async () => {
		const mb = new Mailbox(); const hist = new History()
		for (let i = 1; i <= 10; i++) mb.put(L(200 + i))
		const first = mb.listen()
		const p1 = new Page(mb, hist, true)
		await p1.receive(first.slice(0, 7))
		await wait(40)
		expect(hist.rows.size).toBe(7)
		await p1.receive(first.slice(7)) // three more arrive and are shown, the append is not done
		p1.kill()
		const p2 = new Page(mb, hist, true)
		await p2.receive(mb.listen())
		await wait(40)
		expect([hist.rows.size, hist.records.size, mb.lines.size]).toEqual([10, 10, 0])
	})
})

describe('the mailbox ACK waits for the REMOTE commit: local copy first, then fragment + index + pointer, and only then the ACK', () => {
	it('the six steps on one account and one sendId: 1 local copy stored; 2 remote pointer fails; 3 restart; 4 mailbox redelivery; 5 resume succeeds; 6 only then the ACK; one row, one record, one marker', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.onAck = (h) => { void h; hist.log.push('ack') }
		mb.put(L(10))
		hist.remoteDown = true
		const p1 = new Page(mb, hist, true, 4)
		await p1.receive(mb.listen())
		await wait(20)
		// 1 + 2: the local copy is stored (record + row), the remote pointer failed, nothing was ACKed, and the chat says "saved here, remote not committed" (NOT "not saved")
		expect([hist.records.size, hist.rows.size, hist.remotePending.has('send-10'), hist.remoteCommitted.size]).toEqual([1, 1, true, 0])
		expect(mb.lines.size).toBe(1)
		expect(hist.log).toEqual([])
		expect(remoteUnsentInboundSendIds().has('send-10')).toBe(true)
		expect(unsavedInboundSendIds().has('send-10')).toBe(false)
		// 3: the process is killed; no marker ever reached the disk (it is written only after the confirmed append)
		p1.kill()
		expect(p1.mem.has(hashOf(L(10)))).toBe(false)
		expect(mb.lines.size).toBe(1)
		// 4: the next process gets the redelivery; the remote is still down: still no ACK, still one record and one row
		const p2 = new Page(mb, hist, true, 4)
		await p2.receive(mb.listen())
		await wait(20)
		expect([hist.records.size, hist.rows.size, hist.remoteCommitted.size, mb.lines.size, hist.log.length]).toEqual([1, 1, 0, 1, 0])
		// 5: the remote is back: the page's retry resumes the commit of the SAME record
		hist.remoteDown = false
		await wait(30)
		// 6: the ACK came after the commit, exactly once
		expect(hist.log).toEqual(['commit:send-10', 'ack'])
		expect([hist.records.size, hist.rows.size, hist.remoteCommitted.size, mb.lines.size, mb.acked.length]).toEqual([1, 1, 1, 0, 1])
		expect(p2.mem.has(hashOf(L(10)))).toBe(true) // the dedupe marker is set now (after the confirmed append), once
		expect(remoteUnsentInboundSendIds().has('send-10')).toBe(false)
		expect(unsavedInboundSendIds().has('send-10')).toBe(false)
		// a further redelivery (the ACK was lost, say) after the commit: still one row, ACKed again, no second commit
		mb.put(L(10))
		const p3 = new Page(mb, hist, true, 4)
		await p3.receive(mb.listen())
		await wait(15)
		expect([hist.records.size, hist.rows.size, hist.log.filter((e) => e.startsWith('commit')).length, mb.lines.size]).toEqual([1, 1, 1, 0])
	})

	it('a LOCAL failure (the worker cannot save) is "not saved", not "remote not committed"; the two marks never show together', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(11))
		hist.mode = 'fail'
		const p = new Page(mb, hist, true, 1000)
		await p.receive(mb.listen())
		await wait(15)
		expect(unsavedInboundSendIds().has('send-11')).toBe(true)
		expect(remoteUnsentInboundSendIds().has('send-11')).toBe(false)
		expect(mb.lines.size).toBe(1)
		p.kill()
	})

	it('a failure that turns from remote to local moves the mark (one wording at a time) and a confirmed append clears both', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(12))
		hist.remoteDown = true
		const p = new Page(mb, hist, true, 6)
		await p.receive(mb.listen())
		await wait(12)
		expect([remoteUnsentInboundSendIds().has('send-12'), unsavedInboundSendIds().has('send-12')]).toEqual([true, false])
		hist.remoteDown = false
		hist.mode = 'fail' // the worker now fails before any remote step
		await wait(20)
		expect([remoteUnsentInboundSendIds().has('send-12'), unsavedInboundSendIds().has('send-12')]).toEqual([false, true])
		hist.mode = 'ok'
		await wait(30)
		expect([remoteUnsentInboundSendIds().has('send-12'), unsavedInboundSendIds().has('send-12'), mb.lines.size]).toEqual([false, false, 0])
		p.kill()
	})

	it('a record-mode account (the record keeps bodies) waits for the remote commit as well: no ACK while the remote is down', async () => {
		const mb = new Mailbox(); const hist = new History()
		mb.put(L(13))
		hist.remoteDown = true
		const p = new Page(mb, hist, true, 1000)
		p.recordKeepsBodies = true // record mode: the committed account record keeps the bodies
		await p.receive(mb.listen())
		await wait(15)
		expect([mb.lines.size, hist.remoteCommitted.size]).toEqual([1, 0])
		p.kill()
	})
})

