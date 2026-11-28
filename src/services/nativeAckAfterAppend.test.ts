/**
 * @jest-environment node
 *
 * on a native shell the page sends `ackInbound` for an inbound message ONLY after the `historyAppend` of that message returned ok; a failure or a timeout sends nothing and the page asks
 * again; a message without a sendId (an old plain-text sender, a card without one) is the same; lines that are not written to history (receipts, call signalling, drafts, any dropped line) keep the old behaviour (no
 * `ackInbound` from the settle step). The page declares the capability `ackAfterAppend.v1` in the init payload.
 * SIMULATION, labelled as such: the REAL settle step, the REAL wait (inboundDurable.ts) and the REAL mirror decision (inboundMirror.ts) against a MODELLED native shell (keeps the armor until `ackInbound`, replays what it still holds)
 * and a MODELLED `historyAppend` (ok / fail / hang). It proves the ordering logic; it is not a device run.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { settleInboundBatch, type InboundBatchSettleDeps } from './inboundBatchSettle'
import { inboundMirrorFor } from './inboundMirror'
import { durableStats, resetDurablePendingForTest, type DurableMirror } from './inboundDurable'
import { newInboundLists, recordDroppedLine, recordInboundLine, settleInputOf } from './inboundRowRecord'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const hashOf = (line: string): string => `0x${Buffer.from(line).toString('hex').padEnd(64, '0').slice(0, 64)}`
const src = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8')
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** the modelled native shell: keeps the armor of a line until `ackInbound` names its hash */
class Shell {
	held = new Map<string, string>()
	acks: string[] = []
	log: string[] = []
	put(line: string): void { this.held.set(hashOf(line), line) }
	replay(): string[] { return [...this.held.values()] }
	ackInbound(hashes: string[]): void { for (const h of hashes) { this.held.delete(h); this.acks.push(h); this.log.push('ackInbound') } }
}
/** the modelled historyAppend of the shell: `mode` decides the answer; sendId (or the line when there is none) keys the idempotence */
class Hist {
	mode: 'ok' | 'fail' | 'hang' = 'ok'
	saved = new Set<string>()
	log: string[] = []
	calls = 0
	async append(key: string): Promise<boolean> {
		this.calls += 1
		await wait(1)
		if (this.mode === 'hang') return new Promise<boolean>(() => undefined)
		if (this.mode === 'fail') return false
		this.saved.add(key)
		this.log.push(`append_ok:${key}`)
		return true
	}
}
const keyOf = (line: string): string => line.split('|')[0] as string // "sid|text" has a sendId; "|text" has none (the key is then the whole line)

/** one page batch against the native model, through the real mirror decision, the real settle step and the real wait */
async function receive(shell: Shell, hist: Hist, lines: string[], opts: { drops?: string[]; nativeAckAfterAppend?: boolean; alreadyAcked?: Set<string>; markCalls?: string[]; seen?: Set<string> } = {}): Promise<void> {
	const lists = newInboundLists()
	const seen = opts.seen ?? new Set<string>()
	for (const line of lines) {
		const isNew = !seen.has(line)
		seen.add(line)
		recordInboundLine(lists, line, isNew, {
			mirror: (rowIsNew) => inboundMirrorFor<{ sendId?: string }>({
				browser: false,
				nativeAckAfterAppend: opts.nativeAckAfterAppend ?? true,
				isNew: rowIsNew,
				peer: 'p',
				added: { sendId: keyOf(line) || undefined },
				ack: async () => hist.append(keyOf(line) || line),
				fireAndForget: () => { void hist.append(keyOf(line) || line) },
			}),
			write: () => undefined,
		})
	}
	for (const d of opts.drops ?? []) recordDroppedLine(lists, d)
	const released = new Set<string>()
	const acked = opts.alreadyAcked ?? new Set<string>()
	const deps: InboundBatchSettleDeps = {
		target: {
			browser: false,
			nativeAckAfterAppend: opts.nativeAckAfterAppend ?? true,
			alreadyAcked: (h) => acked.has(h),
			ackMailbox: () => { throw new Error('a native target never posts a mailbox ACK') },
			ackDisplayed: (hs) => { shell.ackInbound(hs); hs.forEach((h) => acked.add(h)) },
		},
		hashesOf: (ls) => ls.filter((l) => !released.has(l)).map(hashOf),
		markHashes: (hs) => { opts.markCalls?.push(...hs); return hs },
		unmarkHashes: () => undefined,
		commit: async () => { shell.log.push('commit'); return true },
		release: (ls) => { ls.forEach((l) => released.add(l)) },
		durableOptions: { sleep: () => wait(3), waitMs: 30, backoffMs: [3] },
	}
	await settleInboundBatch(settleInputOf(lists), deps)
}

beforeEach(() => resetDurablePendingForTest())

describe('native shell: ackInbound only after historyAppend ok', () => {
	it('append ok: ackInbound goes out, and only after the append (and the commit)', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-1|synthetic'; shell.put(line)
		await receive(shell, hist, [line])
		await wait(25)
		expect(shell.acks).toEqual([hashOf(line)])
		expect(hist.log).toEqual(['append_ok:sid-1'])
		expect(shell.held.size).toBe(0)
	})
	it('append FAILS: no ackInbound; the shell still holds the armor; the page asks again and acks only after the first ok', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-2|synthetic'; shell.put(line)
		hist.mode = 'fail'
		await receive(shell, hist, [line])
		await wait(30)
		expect(shell.acks).toEqual([])
		expect(shell.held.size).toBe(1)
		expect(hist.calls).toBeGreaterThanOrEqual(2) // the first attempt plus retries
		expect(durableStats().failures).toBeGreaterThanOrEqual(1)
		hist.mode = 'ok'
		await wait(40)
		expect(shell.acks).toEqual([hashOf(line)])
		expect(hist.log.indexOf('append_ok:sid-2')).toBeGreaterThanOrEqual(0)
		expect(shell.held.size).toBe(0)
	})
	it('append TIMES OUT (never answers): no ackInbound; the wait asks again after its timeout; still nothing acked', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-3|synthetic'; shell.put(line)
		hist.mode = 'hang'
		await receive(shell, hist, [line])
		await wait(80)
		expect(shell.acks).toEqual([])
		expect(hist.calls).toBeGreaterThanOrEqual(2)
		expect(durableStats().failures).toBeGreaterThanOrEqual(2)
		expect(shell.held.size).toBe(1)
		hist.mode = 'fail' // stop the retry loop of this test from ever acking
	})
	it('a message WITHOUT a sendId (old plain-text sender, a card without one) is the same: no ack on failure, ack after ok', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = '|plain text from an old sender'; shell.put(line)
		hist.mode = 'fail'
		await receive(shell, hist, [line])
		await wait(15)
		expect(shell.acks).toEqual([])
		hist.mode = 'ok'
		await wait(40)
		expect(shell.acks).toEqual([hashOf(line)])
		expect(hist.log).toEqual([`append_ok:${line}`])
	})
	it('ordering over a batch: every ackInbound is later than the append ok of its own line', async () => {
		const shell = new Shell(); const hist = new Hist()
		const lines = ['a-1|x', 'a-2|x', '|no sendId']
		lines.forEach((l) => shell.put(l))
		const order: string[] = []
		const origAck = shell.ackInbound.bind(shell)
		shell.ackInbound = (hs) => { for (const h of hs) order.push(`ack:${[...shell.held.entries()].find(([k]) => k === h)?.[1]}`); origAck(hs) }
		const origAppend = hist.append.bind(hist)
		hist.append = async (k) => { const r = await origAppend(k); order.push(`ok:${k}`); return r }
		await receive(shell, hist, lines)
		await wait(40)
		expect(shell.acks.length).toBe(3)
		for (const l of lines) expect(order.indexOf(`ok:${keyOf(l) || l}`)).toBeLessThan(order.indexOf(`ack:${l}`))
	})
	it('lines that are not written to history keep the old behaviour: a dropped line (receipt, call signalling, draft) gets no ackInbound from this step', async () => {
		const shell = new Shell(); const hist = new Hist()
		const row = 'sid-4|x'; const receipt = 'receipt-1|y'; const call = 'call-1|z'
		;[row, receipt, call].forEach((l) => shell.put(l))
		await receive(shell, hist, [row], { drops: [receipt, call] })
		await wait(25)
		expect(shell.acks).toEqual([hashOf(row)])
		expect(shell.held.has(hashOf(receipt))).toBe(true)
		expect(shell.held.has(hashOf(call))).toBe(true)
		expect(hist.calls).toBe(1) // nothing was appended for the dropped lines
	})
	it('no markers are written on the native path (the shell owns the replay)', async () => {
		const shell = new Shell(); const hist = new Hist()
		const marks: string[] = []
		const line = 'sid-5|x'; shell.put(line)
		await receive(shell, hist, [line], { markCalls: marks })
		await wait(25)
		expect(shell.acks.length).toBe(1)
		expect(marks).toEqual([])
	})
	it('a duplicate copy whose hash was already ACKed needs no new ack; a duplicate whose hash never was is acked after its append', async () => {
		const shell = new Shell(); const hist = new Hist()
		const l1 = 'sid-6|x'; const l2 = 'sid-7|x'
		const seen = new Set<string>([l1, l2]) // both are already in the page state: duplicate copies
		await receive(shell, hist, [l1, l2], { seen, alreadyAcked: new Set([hashOf(l1)]) })
		await wait(25)
		expect(shell.acks).toEqual([hashOf(l2)])
	})
	it('a row with NO append to wait for (the mirror returned nothing) is never ackInbound-ed', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-8|x'; shell.put(line)
		const lists = newInboundLists()
		recordInboundLine(lists, line, true, { mirror: () => undefined, write: () => undefined })
		await settleInboundBatch(settleInputOf(lists), {
			target: { browser: false, nativeAckAfterAppend: true, alreadyAcked: () => false, ackMailbox: () => undefined, ackDisplayed: (hs) => shell.ackInbound(hs) },
			hashesOf: (ls) => ls.map(hashOf), markHashes: (h) => h, unmarkHashes: () => undefined, commit: async () => true, release: () => undefined,
		})
		await wait(10)
		expect(shell.acks).toEqual([])
		expect(hist.calls).toBe(0)
	})
	it('a failed store commit sends nothing (and starts no wait)', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-9|x'
		const lists = newInboundLists()
		recordInboundLine(lists, line, true, { mirror: (n) => inboundMirrorFor<{ sendId?: string }>({ browser: false, nativeAckAfterAppend: true, isNew: n, peer: 'p', added: { sendId: 'sid-9' }, ack: async () => hist.append('sid-9'), fireAndForget: () => undefined }), write: () => undefined })
		const ok = await settleInboundBatch(settleInputOf(lists), {
			target: { browser: false, nativeAckAfterAppend: true, alreadyAcked: () => false, ackMailbox: () => undefined, ackDisplayed: (hs) => shell.ackInbound(hs) },
			hashesOf: (ls) => ls.map(hashOf), markHashes: (h) => h, unmarkHashes: () => undefined, commit: async () => false, release: () => undefined,
		})
		await wait(10)
		expect(ok).toBe(false)
		expect(shell.acks).toEqual([])
	})
	it('a shell without the capability (nativeAckAfterAppend false) keeps the old path: ackInbound right after the commit, the old fire-and-forget mirror', async () => {
		const shell = new Shell(); const hist = new Hist()
		const line = 'sid-10|x'; shell.put(line)
		hist.mode = 'fail'
		await receive(shell, hist, [line], { nativeAckAfterAppend: false })
		await wait(10)
		expect(shell.acks).toEqual([hashOf(line)]) // unchanged old behaviour (the old shell acks at store time)
	})
})

describe('the mirror decision for a native line', () => {
	const row = { sendId: 's1' as string | undefined }
	it('with nativeAckAfterAppend a new row and a duplicate each get a DurableMirror (with and without a sendId); the append is awaited, retry asks again', async () => {
		let calls = 0
		const mk = (isNew: boolean, added: { sendId?: string } | null): DurableMirror | undefined => inboundMirrorFor({ browser: false, nativeAckAfterAppend: true, isNew, peer: 'p', added, ack: async () => { calls += 1; return calls > 1 }, fireAndForget: () => { throw new Error('no fire-and-forget on this path') } })
		const a = mk(true, row) as DurableMirror
		expect(await a.done).toBe(false)
		expect(await a.retry()).toBe(true)
		expect(a.sendId).toBe('s1')
		expect((mk(false, row) as DurableMirror).sendId).toBe('s1')
		const noId = mk(true, { sendId: undefined }) as DurableMirror
		expect(noId).toBeDefined()
		expect(noId.sendId).toBeUndefined()
		expect(mk(true, null)).toBeUndefined() // no row: nothing to wait for, never acked
	})
	it('without the flag a native shell keeps the old mirror: fire-and-forget for a new row, nothing for a duplicate', () => {
		const ff: unknown[] = []
		expect(inboundMirrorFor({ browser: false, isNew: true, peer: 'p', added: row, ack: async () => true, fireAndForget: (_p, r) => { ff.push(r) } })).toBeUndefined()
		expect(inboundMirrorFor({ browser: false, nativeAckAfterAppend: false, isNew: false, peer: 'p', added: row, ack: async () => true, fireAndForget: (_p, r) => { ff.push(r) } })).toBeUndefined()
		expect(ff).toEqual([row])
	})
})

describe('wiring pinned (static)', () => {
	it('init declares ackAfterAppend.v1 in pageCapabilities', () => {
		const t = code(src('nativeConetChatTransport.ts'))
		expect(t).toContain("export const ACK_AFTER_APPEND_CAPABILITY = 'ackAfterAppend.v1'")
		expect(t).toMatch(/pageCapabilities: \[ACK_AFTER_APPEND_CAPABILITY\],\s*\}/)
		const initAt = t.indexOf("type: 'init'")
		expect(t.indexOf('pageCapabilities: [ACK_AFTER_APPEND_CAPABILITY]')).toBeGreaterThan(0)
		expect(initAt).toBeGreaterThan(t.indexOf('pageCapabilities: [ACK_AFTER_APPEND_CAPABILITY]')) // the field is in the payload built before the init request
	})
	it('the capability name and field pass the bridge guard (canonical key, no key material)', () => {
		const { findBadKey, findForbiddenKey } = jest.requireActual('./identityPayload') as { findBadKey: (p: unknown) => string | null; findForbiddenKey: (p: unknown) => string | null }
		const payload = { pageCapabilities: ['ackAfterAppend.v1'], deferAck: true, routes: [] }
		expect(findBadKey(payload)).toBeNull()
		expect(findForbiddenKey(payload)).toBeNull()
	})
	it('the bridge targets native only with deferAck, and marks the target; App hands the flag to the mirror', () => {
		const b = code(src('chatWorkerBridge.ts'))
		expect(b).toContain("export const nativeAckAfterAppendActive = (): boolean => !!activeClient && activeClientIsNative && isNativeConetChatClient(activeClient) && daemonAllows('inbound.deferAck')")
		expect(b).toMatch(/browser: false,\s*nativeAckAfterAppend: native !== null,/)
		expect(code(src('../App.tsx'))).toContain('nativeAckAfterAppend: nativeAckAfterAppendActive(), isNew: rowIsNew,')
		expect(code(src('../App.tsx'))).toMatch(/\.\.\.ackTarget,\s*ackDisplayed: \(hashes\) => requestAnimationFrame/) // the spread keeps the flag
	})
	it('the settle step starts the wait for the native path, with ackInbound as its ACK and no markers; the old ackDisplayed-after-commit stays only for a shell without the flag', () => {
		const s = code(src('inboundBatchSettle.ts'))
		const at = s.indexOf('if (deps.target.nativeAckAfterAppend) {')
		expect(at).toBeGreaterThan(0)
		const block = s.slice(at, s.indexOf('const nativeHashes'))
		expect(block).toContain('{ ackMailbox: deps.target.ackDisplayed, markHashes: () => undefined, unmarkHashes: () => undefined }')
		expect(block).not.toMatch(/ackDisplayed\(nativeHashes\)/)
		expect(s.indexOf('if (nativeHashes.length) deps.target.ackDisplayed(nativeHashes)')).toBeGreaterThan(s.indexOf('if (deps.target.nativeAckAfterAppend) {'))
	})
	it('the native history append REJECTS on failure (the legacy queue no longer resolves a failed append)', () => {
		const t = code(src('nativeConetChatTransport.ts'))
		expect(t).toMatch(/item\.fail\(String\(\(ex as Error\)\?\.message \?\? 'history_append_failed'\)\.slice\(0, 80\)\)/)
		expect(t).toContain("this.appendQueue.shift()?.fail('history_append_queue_full')")
		expect(t).toContain("item.fail('history_session_closed')")
		expect(t).not.toMatch(/finally \{\s*item\.done\(\)/)
	})
})
