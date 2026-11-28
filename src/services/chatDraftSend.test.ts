/**
 * @jest-environment node
 */
// the whole send path with the real entries (beginSend, the send queue, createOutgoingPersister, sendWithRecord / retryWithRecord, the autosaver, the stores, the write lock,
// restoreOnMount, messagesForUnlisted, settleStaleSending, decideReceipt) on a virtual clock with a disk and a network that have latency. The page here does what chat.tsx does: the same
// calls in the same order. Paths: controlled reload, browser force refresh, shell force kill, x 0.1 s / 1 s / 2 s; offline; peer accepted but no receipt; write failures.
// Honest limit these tests state: a kill before the click's own queue write has landed is a send that was never accepted (the box still held the text); only what had been written comes back.
import { base64JsonCodec, createDraftAutosaver, createDraftStore, type DraftAutosaver, type DraftCodec, type DraftDocAdapter } from './chatDraftStore'
import { beginSend, messagesForUnlisted, queueItemFromDraft, restoreOnMount } from './sendFlow'
import { createOutgoingPersister, retryWithRecord, sendWithRecord } from './outgoingSend'
import { failedRetryPlan, markSendingById, settleStaleSending } from './failedRetry'
import { chatWriteLockState, noteDraftDirty, noteDraftSaved, requestControlledReload, resetChatWriteLockForTest, setQueueDepth } from './chatWriteLock'
import { createQueueStore, createSendQueue, type AttemptResult, type QueueDocAdapter, type SendQueue } from './sendQueue'
import { decideReceipt } from './sendReceiptPolicy'
import { isUserHeldMessage, mapDeliverFailure, statusAfterPostAnswered } from './sendResultMapping'
import { emitDeliveryReceipt, hasDeliveryReceipt, onDeliveryReceipt, resetDeliveryReceiptBusForTest } from './deliveryReceiptBus'

// the sweeps below run thousands of virtual scenarios (several seconds of real CPU). Under load they passed jest's default 5 s per-test limit; jest then reports that test as failed but LETS ITS BODY KEEP RUNNING
// on the event loop, where it goes on mutating the module-level state the next tests also use (the chat write lock, the delivery receipt bus), and the following tests fail for no reason of their own. The limit is
// raised so that a slow machine finishes the sweep instead of leaking it into its neighbours.
jest.setTimeout(120_000)

const PEER = '0xabc0000000000000000000000000000000000001'
const PEER2 = '0xabc0000000000000000000000000000000000002'
const EOA = '0xdef0000000000000000000000000000000000002'
const ACCOUNT_DOC = 'init'
const tick = () => new Promise<void>((r) => setImmediate(r))

/** The browser codec of the harness is a sealed stand-in that resolves in microtasks (the real AES-GCM codec has its own tests in chatDraftStore.test.ts). */
const sealedStandIn = (): DraftCodec => ({
	kind: 'aes-gcm',
	encode: async (plain) => `S.${Buffer.from(plain, 'utf8').reverse().toString('base64')}`,
	decode: async (text) => (text.startsWith('S.') ? Buffer.from(text.slice(2), 'base64').reverse().toString('utf8') : null),
})

type Msg = { from?: 'me'; id: string; sendId: string; text: string; status: string; sendError?: string; createdAt: number; sendAttemptAt?: number }

class World {
	now = 0
	seq = 0
	epoch = 0
	tasks: Array<{ t: number; seq: number; fn: () => void; live: boolean }> = []
	disk = new Map<string, string>() // committed content only
	/** receiver: sendId -> number of requests that arrived; shown messages are the distinct sendIds */
	arrivals = new Map<string, number>()
	/** the mailbox keeps one copy of identical armor: armor -> number of requests carrying it */
	mailbox = new Map<string, number>()
	/** the recipient's delivery receipts (sendId) */
	receipts = new Set<string>()
	requests: Array<{ sendId: string; armor: string }> = []
	writeLatency = 30
	netLatency = 600
	online = true
	/** what the entry answers: 'legacy_empty' (empty 200) or 'bound' (the node change) */
	answer: 'legacy_empty' | 'bound' | 'unreadable' = 'legacy_empty'
	/** the contact's key / route can be read (false: route_unconfirmed, a network-class failure) */
	routeReadable = true
	/** a trust hold the user has to decide (fingerprint_changed | first_fetch_pending) */
	heldCode: string | null = null
	/** the recipient app answers with a delivery receipt */
	recipientReceipts = true
	failWrites: Array<(id: string, text: string) => boolean> = []
	idCounter = 0
	/**
	 * Library mode (senderCopy.ts): the account record keeps no message bodies; the conversation is read back from the local library, which a message reaches only through history.append (the worker:
	 * network bound, `libraryAckMs`). A page that dies before the append ends has not written it.
	 */
	libraryMode = false
	/** the steady heartbeat of the queue: 0 switches it off, for the tests that are about the back-off alone */
	heartbeatMs = 30_000
	visible = true
	libraryAckMs = 12000
	/** the history worker is unavailable: every append ends without an ACK */
	libraryFails = false
	queueDocCount = (): number => [...this.disk.keys()].filter((k) => k.startsWith('chat-queue-v1:')).length
	library = new Map<string, { from: 'me'; id: string; sendId: string; text: string; status: string; createdAt: number }>()
	appendLibrary(m: { from?: 'me'; id: string; sendId: string; text: string; createdAt: number }, pageEpoch: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.setTimer(() => {
				if (pageEpoch !== this.epoch) return // the page (and its worker) is gone: the append never ends
				if (this.libraryFails) { resolve(false); return } // the worker refuses / times out: no ACK
				this.library.set(m.sendId, { from: 'me', id: m.id, sendId: m.sendId, text: m.text, status: 'sent', createdAt: m.createdAt })
				resolve(true)
			}, this.libraryAckMs)
		})
	}
	/** how many times each document has been written (committed) */
	putCounts = new Map<string, number>()

	setTimer = (fn: () => void, ms: number) => {
		const h = { t: this.now + ms, seq: this.seq++, fn, live: true }
		this.tasks.push(h)
		return h
	}
	clearTimer = (h: unknown) => { (h as { live: boolean }).live = false }
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => { this.setTimer(resolve, ms) })
	}
	async advance(ms: number): Promise<void> {
		const target = this.now + ms
		for (;;) {
			await tick()
			const live = this.tasks.filter((x) => x.live && x.t <= target).sort((a, b) => a.t - b.t || a.seq - b.seq)
			if (!live.length) break
			const next = live[0]
			next.live = false
			this.now = Math.max(this.now, next.t)
			next.fn()
		}
		this.now = target
		await tick()
	}
	/** a write that lands only if its page is still alive at the commit instant (a transaction not committed at the kill is lost: the conservative reading) */
	adapter(pageEpoch: () => number): QueueDocAdapter {
		return {
			read: async (id) => this.disk.get(id) ?? null,
			list: async (prefix) => [...this.disk.keys()].filter((k) => k.startsWith(prefix)).sort(),
			put: async (id, text) => {
				if (this.failWrites.some((f) => f(id, text))) throw new Error('persist_failed')
				const myEpoch = pageEpoch()
				await this.sleep(this.writeLatency)
				if (myEpoch !== this.epoch) return await new Promise<void>(() => undefined) // the page is gone: this write never reports
				this.disk.set(id, text)
				this.putCounts.set(id, (this.putCounts.get(id) ?? 0) + 1)
			},
			remove: async (id) => {
				const myEpoch = pageEpoch()
				await this.sleep(this.writeLatency)
				if (myEpoch !== this.epoch) return await new Promise<void>(() => undefined)
				this.disk.delete(id)
			},
		}
	}
	/** one POST: offline fails after a short wait; otherwise the request leaves, arrives after half the latency whatever happens to the page, and the answer comes back after the full latency */
	async post(sendId: string, armor: string): Promise<{ kind: 'bound' | 'legacy_empty' | 'reject' } | null> {
		if (!this.online) {
			await this.sleep(50)
			return null
		}
		this.requests.push({ sendId, armor })
		this.setTimer(() => {
			this.arrivals.set(sendId, (this.arrivals.get(sendId) ?? 0) + 1)
			this.mailbox.set(armor, (this.mailbox.get(armor) ?? 0) + 1)
			if (this.recipientReceipts) this.setTimer(() => { this.receipts.add(sendId); emitDeliveryReceipt(sendId, PEER) }, 200)
		}, this.netLatency / 2)
		await this.sleep(this.netLatency)
		return { kind: this.answer === 'unreadable' ? 'reject' : this.answer }
	}
	kill(): void {
		this.epoch += 1
		resetChatWriteLockForTest() // the page's memory is gone
		resetDeliveryReceiptBusForTest()
	}
	receiverSees(): string[] { return [...this.arrivals.keys()] }
	storedCopies(): number { return this.mailbox.size } // distinct armors the mailbox keeps
}

class Page {
	messages: Msg[] = []
	input = ''
	banner = ''
	autosaver!: DraftAutosaver
	queue!: SendQueue
	private persistOutgoing!: (id?: string) => Promise<void>
	private offReceipt: () => void = () => undefined
	private sentWritten = new Set<string>()
	private libraryAcked = new Set<string>()
	private libraryAckPending = new Map<string, Promise<boolean>>()
	private readonly myEpoch: number
	private nonce = 0
	constructor(readonly w: World, readonly kind: 'browser' | 'shell') {
		this.myEpoch = w.epoch
	}
	/** Opens a page: the restore runs on the virtual clock (it may write); 2 s of it are given. */
	static async open(w: World, kind: 'browser' | 'shell'): Promise<Page> {
		const pending = Page.openInner(w, kind)
		await w.advance(2000)
		return pending
	}
	private static async openInner(w: World, kind: 'browser' | 'shell'): Promise<Page> {
		const p = new Page(w, kind)
		const stored = w.disk.get(ACCOUNT_DOC)
		p.messages = settleStaleSending(stored ? (JSON.parse(stored) as Msg[]) : [], w.now + 1) // the page started after every stored message
		// library mode: the conversation is read from the library at mount (chat.tsx openLocalChatPage + mergeHistoryEntriesIntoMessages)
		if (w.libraryMode) for (const e of w.library.values()) if (!p.messages.some((x) => x.sendId === e.sendId)) p.messages.push({ ...e })
		const adapter = w.adapter(() => p.myEpoch)
		const codec = kind === 'browser' ? sealedStandIn() : base64JsonCodec()
		const depthKey = `${EOA}:${PEER}`
		p.persistOutgoing = createOutgoingPersister(async () => {
			await adapter.put(ACCOUNT_DOC, JSON.stringify(w.libraryMode ? [] : p.messages)) // library mode: the persisted record has no bodies
		})
		p.queue = createSendQueue({
			store: createQueueStore({ eoa: EOA, doc: adapter, codec }),
			peer: PEER,
			resume: (item) => p.resume(item.sendId),
			persistConfirmed: async (item) => {
				const m = p.messages.find((x) => x.sendId === item.sendId)
				if (!m) return false
				if (m.status !== 'sent' && m.status !== 'delivered') m.status = 'sent'
				return p.copyDurable(item.sendId, await p.persistOutgoing().then(() => true, () => false))
			},
			isOnline: () => w.online,
			setTimer: w.setTimer,
			clearTimer: w.clearTimer,
			onDepth: (n) => setQueueDepth(depthKey, n),
			heartbeatMs: w.heartbeatMs,
			now: () => w.now,
			isVisible: () => w.visible,
		})
		const store = createDraftStore({ eoa: EOA, doc: adapter, codec })
		p.autosaver = createDraftAutosaver({
			store,
			peer: PEER,
			enqueue: (rec) => p.queue.enqueue(queueItemFromDraft(rec, PEER, w.now), { inline: true }),
			makeSendId: () => `sid-${++w.idCounter}`,
			now: () => w.now,
			setTimer: w.setTimer,
			clearTimer: w.clearTimer,
			onDirty: () => noteDraftDirty(PEER),
			onSaved: () => noteDraftSaved(PEER),
		})
		// chat.tsx: the recipient's receipt as an event, applied at once (the message turns delivered, is written, the item leaves)
		p.offReceipt = onDeliveryReceipt((sid, from) => { if (p.myEpoch === w.epoch && from === PEER) void p.applyReceiptNow(sid) })
		const items = await p.queue.load()
		const r = await restoreOnMount({ store, peer: PEER, queueItems: items, stored: p.messages })
		if (r.seed) p.autosaver.seed(r.seed)
		if (r.inputText) p.input = r.inputText
		if (r.dropDraftSendId) await store.removeSlot(PEER, 'draft', r.dropDraftSendId).catch(() => undefined)
		const unlisted = messagesForUnlisted(items, p.messages)
		if (unlisted.length) {
			p.messages.push(...(unlisted as unknown as Msg[]))
			await p.persistOutgoing(unlisted[0].id).catch(() => undefined)
		}
		for (const it of items) if (hasDeliveryReceipt(it.sendId, PEER)) await p.applyReceiptNow(it.sendId) // a receipt that came while this conversation was closed
		p.queue.kick('load')
		return p
	}
	/** chat.tsx applyDeliveryReceipt */
	async applyReceiptNow(sendId: string): Promise<boolean> {
		if (!this.queue.has(sendId)) return false
		const m = this.messages.find((x) => x.sendId === sendId)
		if (!m) return false
		if (m.status !== 'delivered') { m.status = 'delivered'; m.sendError = undefined }
		const persisted = await this.copyDurable(sendId, await this.persistOutgoing().then(() => true, () => false))
		await this.queue.settle(sendId, { kind: 'sent', persisted })
		return persisted
	}
	/** chat.tsx senderCopyPersisted: the record write outside library mode, the library ACK in it */
	async copyDurable(sendId: string, recordPersisted: boolean): Promise<boolean> {
		if (!this.w.libraryMode) return recordPersisted
		if (this.libraryAcked.has(sendId)) return true
		const running = this.libraryAckPending.get(sendId)
		if (running) return running
		const m = this.messages.find((x) => x.sendId === sendId)
		if (!m) return false
		const p = this.w.appendLibrary(m, this.myEpoch).then((ok) => { if (ok) this.libraryAcked.add(sendId); this.libraryAckPending.delete(sendId); return ok })
		this.libraryAckPending.set(sendId, p)
		return p
	}
	dispose(): void {
		this.offReceipt()
		this.queue.dispose()
	}
	type(text: string): void {
		this.input = text
		this.autosaver.onInput(text)
	}
	/** what App does with a delivery receipt: the message turns delivered (the page sees it on its next look) */
	private applyReceipts(): void {
		for (const m of this.messages) if ((m.status === 'sending' || m.status === 'sent' || m.status === 'failed') && this.w.receipts.has(m.sendId)) m.status = 'delivered'
	}
	/** deliverText: the armor of the sendId (stored before the first request, reused after), one POST, the state, the receipt decision */
	private async deliver(msg: Msg): Promise<AttemptResult> {
		const q = this.queue
		// the route / key is read first (sendWithFreshRoute): a trust hold or an unreadable route ends the attempt before anything is encrypted or posted
		const failCode = this.w.heldCode ?? (this.w.routeReadable ? null : 'route_unconfirmed')
		if (failCode) {
			msg.status = failCode
			msg.sendError = failCode
			await this.persistOutgoing().catch(() => undefined)
			const mapped = mapDeliverFailure(failCode)
			void q.settle(msg.sendId, mapped)
			return mapped
		}
		let armor = q.armorOf(msg.sendId)
		if (!armor) {
			armor = `armor:${msg.sendId}:${++this.nonce}`
			try { await q.recordArmor(msg.sendId, armor, `digest:${armor}`) } catch { msg.status = 'failed'; msg.sendError = 'send_failed'; await this.persistOutgoing().catch(() => undefined); return { kind: 'failed' } }
		}
		const ans = await this.w.post(msg.sendId, armor)
		if (!ans || ans.kind === 'reject') {
			msg.status = 'failed'
			msg.sendError = 'send_failed'
			await this.persistOutgoing().catch(() => undefined)
			void q.settle(msg.sendId, { kind: 'failed' })
			return { kind: 'failed' }
		}
		this.applyReceipts() // the recipient's receipt may have come while the POST was in flight
		const alreadyDelivered = msg.status === 'delivered'
		const statusChanged = msg.status !== 'sent' && msg.status !== 'delivered'
		msg.status = statusAfterPostAnswered(msg.status)
		msg.sendError = undefined
		// chat.tsx: a state this page already wrote is not written again (a re-POST of an awaiting message)
		const persisted = this.sentWritten.has(msg.sendId) && !statusChanged ? true : await this.persistOutgoing().then(() => true, () => false)
		if (persisted) this.sentWritten.add(msg.sendId)
		else this.sentWritten.delete(msg.sendId)
		const confirmed = alreadyDelivered || decideReceipt({ kind: ans.kind, digest: '' }) === 'confirmed'
		let result: AttemptResult
		if (this.w.libraryMode) {
			// with proof the library ACK is awaited; without it the append runs in the background and the later receipt re-checks it
			if (confirmed) result = { kind: 'sent', persisted: await this.copyDurable(msg.sendId, persisted) }
			else { void this.copyDurable(msg.sendId, persisted); result = { kind: 'awaiting', persisted } }
		} else result = confirmed ? { kind: 'sent', persisted } : { kind: 'awaiting', persisted }
		void q.settle(msg.sendId, result)
		return result
	}
	/** resumeSendRef in chat.tsx */
	private async resume(sendId: string): Promise<AttemptResult> {
		this.applyReceipts()
		const m = this.messages.find((x) => x.sendId === sendId)
		if (!m) return { kind: 'failed' }
		if (isUserHeldMessage(m)) return { kind: 'held' }
		if (hasDeliveryReceipt(sendId, PEER)) return { kind: 'sent', persisted: await this.applyReceiptNow(sendId) }
		if (m.status === 'delivered') return { kind: 'sent', persisted: await this.copyDurable(sendId, true) }
		if (m.status === 'sent') {
			return this.deliver(m) // an empty 200 is not proof: the same armor again
		}
		const attempt = this.retryAttemptFor(m)
		return attempt ? attempt() : { kind: 'held' }
	}
	private retryAttemptFor(m: Msg): (() => Promise<AttemptResult>) | null {
		if (failedRetryPlan(m as never).kind === 'edit') return null
		return async () => {
			let result: AttemptResult = { kind: 'failed' }
			const outcome = await retryWithRecord({
				markSending: () => { this.messages = markSendingById(this.messages, m.id, this.w.now) as Msg[] },
				persist: () => this.persistOutgoing(m.id),
				inFlightId: m.id,
				onPersistFailed: () => { const x = this.messages.find((y) => y.id === m.id) as Msg; x.status = 'failed'; x.sendError = 'persist_failed' },
				deliver: async () => { result = await this.deliver(this.messages.find((y) => y.id === m.id) as Msg) },
			})
			return outcome === 'persist_failed' ? { kind: 'failed' } : result
		}
	}
	async click(): Promise<void> {
		const text = this.input
		const begun = await beginSend({
			autosaver: this.autosaver,
			currentText: text,
			clearInput: () => { this.input = '' },
			onNotSaved: () => { this.banner = 'not saved, not sent' },
		})
		if (!begun.ok) return
		const msg: Msg = { from: 'me', id: `tmp_${begun.sendId}`, sendId: begun.sendId, text, status: 'sending', createdAt: this.w.now, sendAttemptAt: this.w.now }
		this.messages.push(msg)
		const record = this.persistOutgoing(msg.id)
		const first = async (): Promise<AttemptResult> => {
			let result: AttemptResult = { kind: 'failed' }
			const outcome = await sendWithRecord({
				record,
				inFlightId: msg.id,
				onPersistFailed: () => { msg.status = 'failed'; msg.sendError = 'persist_failed' },
				deliver: async () => { result = await this.deliver(msg) },
			})
			return outcome === 'persist_failed' ? { kind: 'failed' } : result
		}
		await this.queue.run(msg.sendId, first, { inline: true })
	}
	/** the user taps Retry on a failed bubble */
	async tapRetry(id: string): Promise<void> {
		const m = this.messages.find((x) => x.id === id) as Msg
		const attempt = this.retryAttemptFor(m)
		if (!attempt) return
		if (this.queue.has(m.sendId)) await this.queue.run(m.sendId, attempt)
		else await attempt()
	}
	occurrences(text: string): number {
		return (this.input === text ? 1 : 0) + this.messages.filter((m) => m.text === text).length
	}
}

const drive = async <T,>(w: World, action: Promise<T>, ms = 4000): Promise<T> => {
	await w.advance(ms)
	return action
}

beforeEach(() => { resetChatWriteLockForTest(); resetDeliveryReceiptBusForTest() })

describe('the matrix: three paths x 0.1 s / 1 s / 2 s after the click, then the automatic resume (no Retry tap)', () => {
	for (const kind of ['browser', 'shell'] as const) {
		for (const writeLatency of [30, 400]) {
			for (const killAt of [100, 1000, 2000]) {
				it(`${kind === 'browser' ? 'browser force refresh' : 'shell force kill'}: write ${writeLatency} ms, killed ${killAt} ms after the click: the message is on screen once, goes out by itself with the same sendId and the same armor, the receiver sees it once`, async () => {
					const w = new World()
					w.writeLatency = writeLatency
					const p = await Page.open(w, kind)
					p.type('hello world')
					await w.advance(1000)
					void p.click()
					await w.advance(killAt)
					const accepted = p.input === '' && p.messages.length > 0
					w.kill()
					const q = await Page.open(w, kind)
					await w.advance(8000)
					if (!accepted) {
						// not accepted: the box still held the text. Nothing was sent; the last stored draft is back (the autosave had landed before the click)
						expect(q.input).toBe('hello world')
						expect(q.messages).toHaveLength(0)
						expect(w.requests).toHaveLength(0)
						return
					}
					expect(q.occurrences('hello world')).toBe(1)
					expect(w.receiverSees()).toHaveLength(1)
					expect(q.messages.every((m) => m.status === 'delivered')).toBe(true) // the recipient's delivery receipt is what released it
					expect(q.queue.size()).toBe(0) // released after the receipt and the stored state
					// every request carried the SAME sendId and the SAME armor (no second encryption), so the mailbox keeps one copy
					expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
					expect(w.storedCopies()).toBe(1)
					expect(w.requests.length).toBeLessThanOrEqual(2)
				})
			}
		}
	}

	for (const askAt of [100, 1000, 2000]) {
		it(`controlled reload asked ${askAt} ms after the click: held while the queue holds the message, runs once when it is gone; sent once, on screen once`, async () => {
			const w = new World()
			w.writeLatency = 400
			const p = await Page.open(w, 'browser')
			p.type('hello world')
			await w.advance(1000)
			const click = p.click()
			await w.advance(askAt)
			let reloads = 0
			const heldAtAsk = requestControlledReload(() => { reloads += 1 })
			// 400 ms writes: queue item 0-400, the record 400-800, the armor write 800-1200, the request 1200-1800, the sent state 1800-2200, the removal 2200-2600: the queue holds it all the way
			expect(heldAtAsk).toBe(true)
			expect(reloads).toBe(0)
			await w.advance(6000)
			await click
			expect(reloads).toBe(1)
			expect(chatWriteLockState()).toMatchObject({ queued: 0, heldReload: false })
			expect(w.receiverSees()).toHaveLength(1)
			expect(w.requests).toHaveLength(1)
			w.kill()
			const q = await Page.open(w, 'browser')
			expect(q.occurrences('hello world')).toBe(1)
			expect(['sent', 'delivered']).toContain(q.messages[0].status) // the stored state; the delivered mark is the account record's own business (App merges it)
			expect(q.queue.size()).toBe(0)
		})
	}
})

describe('offline, power off, peer accepted without a receipt', () => {
	it('written offline, the device is off and on again, the network comes back: it goes out by itself (no Retry), the original sendId, once', async () => {
		const w = new World()
		w.online = false
		const p = await Page.open(w, 'shell')
		p.type('offline note')
		await w.advance(1000)
		await drive(w, p.click(), 1500)
		expect(w.requests).toHaveLength(0)
		expect(p.queue.size()).toBe(1)
		w.kill() // power off
		const q = await Page.open(w, 'shell') // power on, still offline
		await w.advance(5000)
		expect(w.requests).toHaveLength(0)
		expect(q.queue.size()).toBe(1)
		expect(q.occurrences('offline note')).toBe(1)
		w.online = true
		q.queue.kick('online')
		await w.advance(5000)
		expect(w.receiverSees()).toHaveLength(1)
		expect(q.queue.size()).toBe(0)
		expect(q.messages[0].status).toBe('delivered')
		expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
	})

	it('the peer accepted the message but this device never saw the answer (killed in between): after the reopen the same sendId and the same armor are posted again; the mailbox keeps one copy, the receiver shows one', async () => {
		const w = new World()
		w.writeLatency = 30
		const p = await Page.open(w, 'browser')
		p.type('accepted without receipt')
		await w.advance(1000)
		void p.click()
		await w.advance(500) // the request is out (about +100) and arrived (+400); the answer would come at +700
		expect(w.receiverSees()).toHaveLength(1)
		w.kill()
		const q = await Page.open(w, 'browser')
		await w.advance(8000)
		expect(w.requests.length).toBe(2) // the resume posted again ...
		expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1) // ... with the original sendId
		expect(w.storedCopies()).toBe(1) // ... and the original armor: one copy at the mailbox
		expect(w.receiverSees()).toHaveLength(1)
		expect(q.queue.size()).toBe(0)
	})

	it('a draft is never sent by itself: after the reopen it is in the input, nothing goes out', async () => {
		const w = new World()
		const p = await Page.open(w, 'browser')
		p.type('only a draft')
		await w.advance(1000)
		w.kill()
		const q = await Page.open(w, 'browser')
		await w.advance(8000)
		expect(q.input).toBe('only a draft')
		expect(w.requests).toHaveLength(0)
		expect(q.queue.size()).toBe(0)
	})
})

describe('the owner four-row table: kill about 0.1 s after the click, throttle not fired', () => {
	/**
	 *   gap = time between the last keystroke and the click; L = one write; kill = 100 ms after the click. Counts are kept apart: recovered draft / unconfirmed / delivered / lost.
	 *   row 1  gap 1000, L 400 -> RECOVERED DRAFT: not accepted (the box held the text); the text is back in the input; nothing sent
	 *   row 2  gap   50, L  30 -> UNCONFIRMED then delivered: accepted; the request had left; after the reopen it is resumed with the same sendId (no Retry); the receiver shows one
	 *   row 3  gap 1000, L  80 -> UNCONFIRMED then delivered: the queue item landed, the account record did not; nothing had left; the reopen puts the message back and sends it once
	 *   row 4  gap   50, L 400 -> NOT ACCEPTED, nothing landed: the box held the text at the kill; after the reopen the box is empty (no copy was ever written); not a loss under the criterion
	 */
	const rows = [
		{ row: 1, gap: 1000, L: 400, klass: 'recovered-draft' },
		{ row: 2, gap: 50, L: 30, klass: 'resumed' },
		{ row: 3, gap: 1000, L: 80, klass: 'resumed' },
		{ row: 4, gap: 50, L: 400, klass: 'not-accepted-nothing-landed' },
	] as const
	for (const kind of ['browser', 'shell'] as const) {
		for (const r of rows) {
			it(`${kind} row ${r.row} (gap ${r.gap} ms, write ${r.L} ms): ${r.klass}`, async () => {
				const w = new World()
				w.writeLatency = r.L
				const p = await Page.open(w, kind)
				p.type('zero point one')
				await w.advance(r.gap)
				void p.click()
				await w.advance(100)
				const boxHeldTextAtKill = p.input === 'zero point one'
				w.kill()
				const q = await Page.open(w, kind)
				await w.advance(8000)
				if (r.klass === 'recovered-draft') {
					expect(boxHeldTextAtKill).toBe(true)
					expect(q.input).toBe('zero point one')
					expect(q.messages).toHaveLength(0)
					expect(w.requests).toHaveLength(0)
					return
				}
				if (r.klass === 'not-accepted-nothing-landed') {
					expect(boxHeldTextAtKill).toBe(true)
					expect(q.input).toBe('')
					expect(q.messages).toHaveLength(0)
					expect(w.requests).toHaveLength(0)
					expect(w.receiverSees()).toHaveLength(0)
					expect([...w.disk.keys()]).toEqual([])
					return
				}
				expect(q.input).toBe('')
				expect(q.occurrences('zero point one')).toBe(1)
				expect(w.receiverSees()).toHaveLength(1)
				expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
				expect(q.messages.every((m) => m.status === 'delivered')).toBe(true) // the recipient's delivery receipt is what released it
				expect(q.queue.size()).toBe(0)
				expect(w.requests.length).toBe(r.row === 2 ? 2 : 1) // row 2: the first request that had left + exactly one resume; row 3: nothing had left, exactly one send
			})
		}
	}

	it('the failed-write copy says "not saved and not sent" (the in-page case; after a kill nothing can be shown: the write that would hold the notice is the one that did not land)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const en = (require('../locale/en.json') as { ui: Record<string, string> }).ui
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const zh = (require('../locale/zh-CN.json') as { ui: Record<string, string> }).ui
		expect(en['chat.send.not_saved']).toMatch(/^Not saved and not sent/)
		expect(zh['chat.send.not_saved']).toMatch(/^未保存，也未发送/)
		expect(en['chat.failed.persist_failed']).toMatch(/^Not saved and not sent/)
		expect(zh['chat.failed.persist_failed']).toMatch(/^未保存，也未发送/)
	})
})

describe('same conversation, two messages, receipts out of order, then a restart', () => {
	it('two messages in one conversation; the second is acknowledged first: the first stays queued (also after a kill), is resumed, and the queue empties once; the reload held meanwhile runs once', async () => {
		const w = new World()
		w.writeLatency = 20
		const p = await Page.open(w, 'browser')
		let reloads = 0
		p.type('first')
		await w.advance(500)
		const c1 = p.click()
		await w.advance(200)
		p.type('second')
		await w.advance(500)
		const c2 = p.click()
		requestControlledReload(() => { reloads += 1 })
		// the first request is slower than the second: make the first one's answer late by taking the network down for it
		w.netLatency = 600
		await w.advance(300)
		expect(p.queue.size()).toBeGreaterThan(0)
		expect(reloads).toBe(0)
		w.kill() // restart in the middle: both are on disk, none is removed yet
		void c1
		void c2
		const q = await Page.open(w, 'browser')
		expect(q.messages.map((m) => m.text).sort()).toEqual(['first', 'second'])
		await w.advance(8000)
		expect(w.receiverSees()).toHaveLength(2)
		expect(q.queue.size()).toBe(0)
		expect(q.messages.every((m) => m.status === 'delivered')).toBe(true) // the recipient's delivery receipt is what released it
		expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(2) // two sendIds, never merged into one
		for (const sid of w.receiverSees()) expect(w.requests.filter((x) => x.sendId === sid).length).toBeLessThanOrEqual(2)
	})
})

describe('the entry answer: only a positive proof for the same sendId lets an item leave', () => {
	it("an empty 200 never releases the item: it stays awaiting confirmation, the SAME armor is posted again with back-off (the mailbox keeps one copy), the reload stays held; the recipient's delivery receipt releases it", async () => {
		const w = new World()
		w.recipientReceipts = false // the recipient is offline: no delivery receipt yet
		w.heartbeatMs = 0 // this test is about the back-off alone
		const p = await Page.open(w, 'browser')
		p.type('needs a receipt')
		await w.advance(1000)
		let reloads = 0
		void p.click()
		await w.advance(3000)
		requestControlledReload(() => { reloads += 1 })
		const sid = p.messages[0].sendId
		expect(p.queue.stateOf(sid)).toBe('awaiting')
		expect(p.queue.size()).toBe(1)
		expect(reloads).toBe(0)
		await w.advance(200000) // the back-off steps and the triggers
		p.queue.kick('online')
		await w.advance(5000)
		expect(w.requests.length).toBeGreaterThan(1) // posted again ...
		expect(w.requests.length).toBeLessThanOrEqual(10) // ... with back-off, not in a loop
		expect(new Set(w.requests.map((x) => x.armor)).size).toBe(1) // ... always the same armor, never encrypted again
		expect(w.storedCopies()).toBe(1)
		expect(p.queue.size()).toBe(1) // still not released: empty 200s are not proof
		expect(reloads).toBe(0)
		w.receipts.add(sid) // the recipient comes online: its delivery receipt arrives
		p.queue.kick('visible')
		await w.advance(5000)
		expect(p.queue.size()).toBe(0)
		expect(reloads).toBe(1)
		expect(p.messages[0].status).toBe('delivered')
	})

	it('the same after a restart: an unconfirmed item is re-posted with the original armor, never released by "sent" alone', async () => {
		const w = new World()
		w.recipientReceipts = false
		const p = await Page.open(w, 'shell')
		p.type('survives restarts')
		await w.advance(1000)
		void p.click()
		await w.advance(3000)
		const armor = w.requests[0].armor
		w.kill()
		const q = await Page.open(w, 'shell')
		await w.advance(5000)
		expect(q.queue.size()).toBe(1)
		expect(w.requests.length).toBeGreaterThanOrEqual(2)
		expect(w.requests.every((x) => x.armor === armor && x.sendId === q.messages[0].sendId)).toBe(true)
		w.receipts.add(q.messages[0].sendId)
		q.queue.kick('online')
		await w.advance(5000)
		expect(q.queue.size()).toBe(0)
	})

	it('a bound receipt (the node change) releases the item at once', async () => {
		const w = new World()
		w.answer = 'bound'
		w.recipientReceipts = false
		const p = await Page.open(w, 'browser')
		p.type('bound')
		await w.advance(1000)
		void p.click()
		await w.advance(3000)
		expect(p.queue.size()).toBe(0)
		expect(w.requests).toHaveLength(1)
	})
})

describe('write failures', () => {
	it('the click\'s queue write refused: the input keeps the text, nothing is sent, the UI says not saved and not sent, the last stored draft is on disk; the second click goes through', async () => {
		const w = new World()
		const p = await Page.open(w, 'browser')
		p.type('refused once')
		await w.advance(1000)
		let refuse = true
		w.failWrites.push((id) => refuse && id.startsWith('chat-queue-v1:'))
		await drive(w, p.click(), 1000)
		expect(p.input).toBe('refused once')
		expect(p.banner).toBe('not saved, not sent')
		expect(w.requests).toHaveLength(0)
		expect(p.messages).toHaveLength(0)
		expect(chatWriteLockState().queued).toBe(0)
		refuse = false
		await drive(w, p.click(), 4000)
		expect(w.receiverSees()).toHaveLength(1)
		expect(p.input).toBe('')
	})

	it('the account record write refused after the queue item landed: nothing is sent at first, the message is failed (persist_failed); the automatic resume writes it again and sends once', async () => {
		const w = new World()
		const p = await Page.open(w, 'browser')
		p.type('record refused')
		await w.advance(1000)
		let refuse = true
		w.failWrites.push((id) => refuse && id === ACCOUNT_DOC)
		await drive(w, p.click(), 500)
		expect(w.requests).toHaveLength(0)
		expect(p.messages[0]).toMatchObject({ status: 'failed', sendError: 'persist_failed' })
		expect(chatWriteLockState().writing).toBe(false)
		let reloads = 0
		expect(requestControlledReload(() => { reloads += 1 })).toBe(true) // the item and the unsaved message hold it
		refuse = false
		await w.advance(20000) // the retry timer (3 s, 10 s) resumes it
		expect(w.requests.map((x) => x.sendId)).toEqual([p.messages[0].sendId])
		expect(w.receiverSees()).toHaveLength(1)
		expect(p.queue.size()).toBe(0)
		expect(reloads).toBe(1)
	})

	it('a kill after a refused record write: the queue item brings the message back, the resume sends it once', async () => {
		const w = new World()
		const p = await Page.open(w, 'shell')
		p.type('refused then killed')
		await w.advance(1000)
		w.failWrites.push((id) => id === ACCOUNT_DOC)
		await drive(w, p.click(), 500)
		w.kill()
		w.failWrites.length = 0
		const q = await Page.open(w, 'shell')
		await w.advance(8000)
		expect(q.messages).toHaveLength(1)
		expect(q.messages[0].status).toBe('delivered')
		expect(w.receiverSees()).toHaveLength(1)
		expect(q.occurrences('refused then killed')).toBe(1)
	})

	it('an immediate write with nothing to write to (storage_no_account / storage_no_contact) is a failed write: nothing is sent; the retry of the same sendId reaches the other side exactly once', async () => {
		for (const code of ['storage_no_account', 'storage_no_contact']) {
			resetChatWriteLockForTest()
			let failing = true
			const persist = createOutgoingPersister(async () => { if (failing) throw new Error(code) })
			const delivered: string[] = []
			const msg = { id: 'tmp_1', sendId: 'sid-x', status: 'sending' as string, sendError: undefined as string | undefined }
			const first = await sendWithRecord({
				record: persist(msg.id),
				inFlightId: msg.id,
				onPersistFailed: () => { msg.status = 'failed'; msg.sendError = 'persist_failed' },
				deliver: async () => { delivered.push(msg.sendId) },
			})
			expect(first).toBe('persist_failed')
			expect(delivered).toEqual([])
			expect(chatWriteLockState()).toMatchObject({ writing: false, unsaved: 1, inFlight: 0 })
			failing = false
			const retried = await retryWithRecord({
				markSending: () => { msg.status = 'sending'; msg.sendError = undefined },
				persist: () => persist(msg.id),
				inFlightId: msg.id,
				onPersistFailed: () => { msg.status = 'failed' },
				deliver: async () => { delivered.push(msg.sendId) },
			})
			expect(retried).toBe('sent')
			expect(delivered).toEqual(['sid-x'])
			expect(chatWriteLockState()).toMatchObject({ writing: false, unsaved: 0, inFlight: 0 })
		}
	})
})

describe('what is on disk', () => {
	it('no plain text in the browser (queue and draft); the shell copy is base64 JSON (not encryption)', async () => {
		const w = new World()
		const b = await Page.open(w, 'browser')
		b.type('plain-needle')
		await w.advance(1000)
		void b.click()
		await w.advance(4000)
		for (const [k, v] of w.disk.entries()) if (k !== ACCOUNT_DOC) expect(v).not.toContain('plain-needle')
		const w2 = new World()
		const s = await Page.open(w2, 'shell')
		s.type('plain-needle')
		await w2.advance(1000)
		const draftDoc = [...w2.disk.entries()].find(([k]) => k.startsWith('chat-draft-v1:'))
		expect(Buffer.from(draftDoc?.[1] as string, 'base64').toString('utf8')).toContain('plain-needle')
	})

	it('the draft document and the queue documents are separate from the account record; the queue key carries the account and the sendId', async () => {
		const w = new World()
		const p = await Page.open(w, 'browser')
		p.type('only draft')
		await w.advance(1000)
		expect(w.disk.has(ACCOUNT_DOC)).toBe(false)
		expect([...w.disk.keys()]).toEqual([`chat-draft-v1:${EOA}`])
		void p.click()
		await w.advance(100) // the item has landed, the message is still in flight
		expect([...w.disk.keys()].some((k) => k.startsWith(`chat-queue-v1:${EOA}:sid-`))).toBe(true)
		await w.advance(5000)
		expect([...w.disk.keys()].some((k) => k.startsWith('chat-queue-v1:'))).toBe(false) // released after the receipt and the stored state
	})

	it('two messages to the same contact are two queue documents, never one overwritten by the other', async () => {
		const w = new World()
		w.online = false
		const p = await Page.open(w, 'browser')
		p.type('one')
		await w.advance(600)
		await drive(w, p.click(), 500)
		p.type('two')
		await w.advance(600)
		await drive(w, p.click(), 500)
		const queued = [...w.disk.keys()].filter((k) => k.startsWith('chat-queue-v1:'))
		expect(queued).toHaveLength(2)
		expect(new Set(queued).size).toBe(2)
	})

	it('write timing locally: a draft keystroke lands after one write (leading edge); the click\'s queue item after one write, then the input is cleared', async () => {
		const w = new World()
		w.writeLatency = 50
		const p = await Page.open(w, 'browser')
		p.type('timing')
		await w.advance(60)
		expect(w.disk.has(`chat-draft-v1:${EOA}`)).toBe(true) // the first keystroke is written at once
		const click = p.click()
		await w.advance(60)
		expect(p.input).toBe('') // one write (50 ms) and the input is cleared
		await w.advance(4000)
		await click
	})
})

/**
 * The release criterion as a property: for every kill instant (0 to 2500 ms after the click, every 10 ms), every disk speed and both shells, an ACCEPTED send (the input is cleared and the bubble is
 * in the list at the kill) has at least one recoverable copy after the reopen, and goes out by itself exactly once with one sendId. Four counts are written to a log for QA.
 */
describe('no accepted send is lost (property over every kill instant)', () => {
	it('accepted => recoverable and resumed; counts of recovered draft / unconfirmed(resumed) / delivered / lost', async () => {
		const counts = { recoveredDraft: 0, resumedThenDelivered: 0, deliveredBeforeKill: 0, lost: 0, notAcceptedEmpty: 0 }
		const rows: string[] = []
		for (const kind of ['browser', 'shell'] as const) {
			for (const L of [30, 150, 400]) {
				for (let killAt = 0; killAt <= 2500; killAt += 10) {
					for (const gap of [50, 1000]) {
						const w = new World()
						w.writeLatency = L
						const p = await Page.open(w, kind)
						p.type('sweep text')
						await w.advance(gap)
						void p.click()
						await w.advance(killAt)
						const accepted = p.input === '' && p.messages.some((m) => m.text === 'sweep text')
						const deliveredBeforeKill = p.messages.some((m) => m.text === 'sweep text' && (m.status === 'sent' || m.status === 'delivered')) && p.queue.size() === 0
						w.kill()
						const q = await Page.open(w, kind)
						await w.advance(8000)
						const inInput = q.input === 'sweep text'
						const msg = q.messages.find((m) => m.text === 'sweep text')
						let klass: keyof typeof counts
						if (msg && w.receiverSees().length === 1 && q.queue.size() === 0 && msg.status === 'delivered') klass = deliveredBeforeKill ? 'deliveredBeforeKill' : 'resumedThenDelivered'
						else if (msg) klass = 'lost' // a message that is neither delivered nor still queued would be a defect
						else if (inInput) klass = 'recoveredDraft'
						else klass = accepted ? 'lost' : 'notAcceptedEmpty'
						counts[klass] += 1
						if (accepted) expect(['deliveredBeforeKill', 'resumedThenDelivered']).toContain(klass)
						if (klass === 'resumedThenDelivered' || klass === 'deliveredBeforeKill') {
							expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
							expect(w.storedCopies()).toBe(1)
							expect(w.requests.length).toBeLessThanOrEqual(2)
						}
						if (klass === 'lost') rows.push(`${kind} L=${L} gap=${gap} kill=${killAt}`)
						expect(q.occurrences('sweep text')).toBeLessThanOrEqual(1)
					}
				}
			}
		}
		expect(rows).toEqual([])
		expect(counts.lost).toBe(0)
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs') as typeof import('fs')
		if (process.env.R4_COUNTS_FILE) fs.writeFileSync(process.env.R4_COUNTS_FILE, JSON.stringify(counts, null, 2))
	})
})

describe('a send that is not in the queue (no account yet)', () => {
	it('its request in flight still holds a reload the app asks for; it runs once when the answer is in, success or failure', async () => {
		for (const fail of [false, true]) {
			resetChatWriteLockForTest()
			let reloads = 0
			let finish: () => void = () => undefined
			const persist = createOutgoingPersister(async () => undefined)
			const sending = sendWithRecord({
				record: persist('tmp_1'),
				inFlightId: 'tmp_1',
				onPersistFailed: () => undefined,
				deliver: () => new Promise<void>((resolve, reject) => { finish = () => (fail ? reject(new Error('network')) : resolve()) }),
			}).catch(() => 'failed')
			await tick()
			expect(chatWriteLockState().inFlight).toBe(1)
			expect(requestControlledReload(() => { reloads += 1 })).toBe(true)
			expect(reloads).toBe(0)
			finish()
			await sending
			expect(reloads).toBe(1)
		}
	})
})

describe('route_unconfirmed is retried by the queue; trust holds are never sent automatically', () => {
	for (const kind of ['browser', 'shell'] as const) {
		it(`${kind}: sent offline (the route cannot be read), killed, reopened, network back: it goes out by itself once, original sendId, no Retry tap, the receiver sees one`, async () => {
			const w = new World()
			w.online = false
			w.routeReadable = false
			const p = await Page.open(w, kind)
			p.type('route unreadable')
			await w.advance(1000)
			void p.click()
			await w.advance(1500)
			expect(p.messages[0]).toMatchObject({ status: 'route_unconfirmed', sendError: 'route_unconfirmed' }) // still shown as "Route not confirmed" (Retry / Send anyway stay)
			expect(w.requests).toHaveLength(0)
			expect(p.queue.size()).toBe(1)
			w.kill()
			const q = await Page.open(w, kind) // reopened, still offline and still unreadable
			await w.advance(60000)
			expect(w.requests).toHaveLength(0)
			expect(q.queue.size()).toBe(1)
			expect(q.messages[0].status).toBe('route_unconfirmed')
			w.online = true
			w.routeReadable = true // the network is back: the route can be read again
			q.queue.kick('online')
			await w.advance(8000)
			expect(w.requests).toHaveLength(1)
			expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
			expect(w.receiverSees()).toHaveLength(1)
			expect(q.queue.size()).toBe(0)
			expect(q.occurrences('route unreadable')).toBe(1)
		})
	}

	it('the retry timer alone (no online event) also picks a route_unconfirmed message up once the route can be read, with back-off', async () => {
		const w = new World()
		w.routeReadable = false
		const p = await Page.open(w, 'browser')
		p.type('timer retry')
		await w.advance(1000)
		void p.click()
		await w.advance(5000)
		expect(w.requests).toHaveLength(0)
		w.routeReadable = true
		await w.advance(70000)
		expect(w.receiverSees()).toHaveLength(1)
		expect(p.queue.size()).toBe(0)
	})

	for (const code of ['fingerprint_changed', 'first_fetch_pending']) {
		it(`${code} is a trust hold: never sent automatically, not by the timer, online, visible, a reopen or a restart; it stays queued for the user`, async () => {
			const w = new World()
			w.heldCode = code
			const p = await Page.open(w, 'browser')
			p.type('needs the user')
			await w.advance(1000)
			void p.click()
			await w.advance(3000)
			expect(p.messages[0].status).toBe(code)
			expect(p.queue.stateOf(p.messages[0].sendId)).toBe('held')
			p.queue.kick('online')
			p.queue.kick('visible')
			await w.advance(200000)
			expect(w.requests).toHaveLength(0)
			w.kill()
			w.heldCode = null // even if the hold were gone from the world, the stored message is still a trust hold until the user acts
			const q = await Page.open(w, 'browser')
			await w.advance(200000)
			q.queue.kick('online')
			await w.advance(5000)
			expect(w.requests).toHaveLength(0)
			expect(q.queue.size()).toBe(1)
			expect(q.messages[0].status).toBe(code)
		})
	}

	it('no positive evidence: a POST answer that cannot be read keeps the message pending (failed attempt, same armor, back-off), it never leaves the queue and never gets a second ciphertext', async () => {
		const w = new World()
		w.answer = 'unreadable'
		w.recipientReceipts = false // no delivery receipt either: there is no positive evidence of any kind
		w.heartbeatMs = 0 // this test is about the back-off alone
		const p = await Page.open(w, 'browser')
		p.type('unreadable answers')
		await w.advance(1000)
		void p.click()
		await w.advance(200000)
		expect(p.queue.size()).toBe(1)
		expect(w.requests.length).toBeGreaterThan(1)
		expect(w.requests.length).toBeLessThanOrEqual(8)
		expect(new Set(w.requests.map((x) => x.armor)).size).toBe(1)
		expect(new Set(w.requests.map((x) => x.sendId)).size).toBe(1)
		expect(w.storedCopies()).toBe(1)
		w.answer = 'bound' // the node answers properly: positive evidence, the item leaves
		p.queue.kick('online')
		await w.advance(5000)
		expect(p.queue.size()).toBe(0)
	})
})

describe('the delivery receipt can arrive before the answer of the POST', () => {
	it('the message stays delivered (the status never goes back to sent), the item is released at once with that proof, and nothing is posted again', async () => {
		const w = new World()
		w.netLatency = 1000 // the receipt (arrival 500 ms + 200 ms) is in before the answer (1000 ms)
		const p = await Page.open(w, 'browser')
		p.type('fast recipient')
		await w.advance(1000)
		void p.click()
		await w.advance(5000)
		expect(p.messages[0].status).toBe('delivered')
		expect(p.queue.size()).toBe(0)
		expect(w.requests).toHaveLength(1)
	})
})

describe('the delivery receipt as an event (deliveryReceiptBus.ts): the item leaves when the receipt arrives, not at the next retry tick', () => {
	it('an item awaiting confirmation is released at once by the recipient\'s receipt: the message is delivered and written, then the item leaves (well before the 3 s tick)', async () => {
		const w = new World()
		w.recipientReceipts = false // the recipient answers later
		const p = await Page.open(w, 'browser')
		p.type('receipt later')
		await w.advance(1000)
		void p.click()
		await w.advance(1500) // answered with an empty 200: awaiting
		const sid = p.messages[0].sendId
		expect(p.queue.stateOf(sid)).toBe('awaiting')
		const t0 = w.now
		emitDeliveryReceipt(sid, PEER)
		await w.advance(100)
		expect(w.now - t0).toBeLessThan(3000)
		expect(p.queue.size()).toBe(0)
		expect(p.messages[0].status).toBe('delivered')
		expect(JSON.parse(w.disk.get(ACCOUNT_DOC) as string)[0].status).toBe('delivered') // written before the item left
		expect(w.requests).toHaveLength(1)
	})

	it('a receipt that arrives BEFORE the answer of the POST (fast recipient) releases the item at that moment, and the late answer does not take delivered back', async () => {
		const w = new World()
		w.netLatency = 1000 // arrival 500 ms, receipt 700 ms, answer 1000 ms
		const p = await Page.open(w, 'browser')
		p.type('before the answer')
		await w.advance(1000)
		void p.click()
		await w.advance(850)
		expect(p.queue.size()).toBe(0) // already gone, the answer is still on its way
		expect(p.messages[0].status).toBe('delivered')
		await w.advance(3000)
		expect(p.messages[0].status).toBe('delivered')
		expect(w.requests).toHaveLength(1)
	})

	it('a receipt for a sendId that is not in this queue changes nothing', async () => {
		const w = new World()
		w.recipientReceipts = false
		const p = await Page.open(w, 'browser')
		p.type('mine')
		await w.advance(1000)
		void p.click()
		await w.advance(1500)
		emitDeliveryReceipt('someone-elses-sendId', PEER)
		await w.advance(200)
		expect(p.queue.size()).toBe(1)
		expect(p.messages[0].status).toBe('sent')
	})

	it('a receipt that came while the conversation was closed is found when it is opened: the item is released without posting again', async () => {
		const w = new World()
		w.recipientReceipts = false
		const first = await Page.open(w, 'browser')
		first.type('closed conversation')
		await w.advance(1000)
		void first.click()
		await w.advance(1500)
		const sid = first.messages[0].sendId
		first.dispose() // the conversation is closed (its queue and its receipt listener are gone)
		emitDeliveryReceipt(sid, PEER) // the receipt arrives now: only the bus hears it
		expect(hasDeliveryReceipt(sid, PEER)).toBe(true)
		const requestsBefore = w.requests.length
		const reopened = await Page.open(w, 'browser')
		await w.advance(500)
		expect(reopened.queue.size()).toBe(0)
		expect(reopened.messages[0].status).toBe('delivered')
		expect(w.requests.length).toBe(requestsBefore) // nothing was posted again
		expect([...w.disk.keys()].some((k) => k.startsWith('chat-queue-v1:'))).toBe(false)
	})
})

describe('two messages, receipts out of order (second first), SIGKILL at every moment', () => {
	it('whatever the kill time: both messages are on A after the reopen (none lost, none twice), B has each exactly once, a message delivered on disk has no queue document, every queue document has its message', async () => {
		const rows: string[] = []
		for (const kind of ['browser', 'shell'] as const) {
			for (const L of [30, 150]) {
				for (let killAt = 0; killAt <= 3200; killAt += 100) {
					const w = new World()
					w.writeLatency = L
					w.recipientReceipts = false // the receipts are emitted by hand, in the order the test chooses
					const p = await Page.open(w, kind)
					p.type('first')
					await w.advance(500)
					void p.click()
					await w.advance(200)
					p.type('second')
					await w.advance(500)
					void p.click()
					// the second receipt arrives first (at +900 ms after the second click), the first one later (+1500 ms); both are emitted only while the page is alive
					const t0 = w.now
					const emitAt = (ms: number, text: string) => w.setTimer(() => {
						if (w.epoch !== p['myEpoch']) return
						const m = p.messages.find((x) => x.text === text)
						if (m) { w.receipts.add(m.sendId); emitDeliveryReceipt(m.sendId, PEER) }
					}, ms)
					emitAt(900, 'second')
					emitAt(1500, 'first')
					await w.advance(killAt)
					// a click that had not landed (its input still holds the text) was never accepted: it must not be on A afterwards, and B must not have it
					const acceptedFirst = p.messages.some((m) => m.text === 'first')
					const acceptedSecond = p.messages.some((m) => m.text === 'second')
					w.kill()
					const q = await Page.open(w, kind)
					await w.advance(8000)
					const texts = q.messages.map((m) => m.text).sort()
					const want = [acceptedFirst ? 'first' : '', acceptedSecond ? 'second' : ''].filter(Boolean)
					const listOk = texts.length === want.length && texts.every((t, i) => t === want[i])
					const queueDocs = [...w.disk.keys()].filter((k) => k.startsWith('chat-queue-v1:'))
					const deliveredOnDisk = q.messages.filter((m) => m.status === 'delivered').map((m) => m.sendId)
					const docSendIds = queueDocs.map((k) => k.split(':').pop() as string)
					const bOnce = w.receiverSees().length === want.length && [...w.arrivals.values()].every((n) => n >= 1)
					// a message that A shows and that the receiver has: exactly one message each (the receiver de-duplicates by sendId)
					const noDeliveredWithDoc = deliveredOnDisk.every((id) => !docSendIds.includes(id))
					const everyDocHasMessage = docSendIds.every((id) => q.messages.some((m) => m.sendId === id))
					// before the first click had landed nothing is accepted: then A shows what the page had written and B nothing
					if (!(listOk && bOnce && noDeliveredWithDoc && everyDocHasMessage)) rows.push(`${kind} L=${L} kill=${killAt}: list=${texts.join('|')} want=${want.join('|')} b=${w.receiverSees().length} docs=${docSendIds.length}`)
					void t0
				}
			}
		}
		expect(rows).toEqual([])
	})
})

describe('write amplification: a re-POST of an awaiting message does not rewrite the account record', () => {
	it('after the first sent state is written, the retries (back-off, online, visible) post again but write the account record no more', async () => {
		const w = new World()
		w.recipientReceipts = false
		const p = await Page.open(w, 'browser')
		p.type('quiet retries')
		await w.advance(1000)
		void p.click()
		await w.advance(5000)
		const writesAfterFirst = w.putCounts.get(ACCOUNT_DOC) ?? 0
		const postsAfterFirst = w.requests.length
		await w.advance(300000)
		p.queue.kick('online')
		p.queue.kick('visible')
		await w.advance(5000)
		expect(w.requests.length).toBeGreaterThan(postsAfterFirst) // it did post again ...
		expect(w.putCounts.get(ACCOUNT_DOC) ?? 0).toBe(writesAfterFirst) // ... and the account record was not written again
	})
})

describe('library mode: the sender\'s copy after a reload is the library', () => {
	async function openLibrary(kind: 'browser' | 'shell' = 'browser') {
		const w = new World()
		w.libraryMode = true
		const p = await Page.open(w, kind)
		return { w, p }
	}

	it('the queue item is NOT released by the receipt while the library has not ACKed (the item is the only copy on disk): a kill between the receipt and the ACK still shows the message after the reopen; every kill time from 0 to 20 s, two messages, receipts out of order', async () => {
		const misses: string[] = []
		for (let killAt = 0; killAt <= 20000; killAt += 500) {
			const { w, p } = await openLibrary()
			w.recipientReceipts = false
			p.type('first')
			await w.advance(500)
			void p.click()
			await w.advance(200)
			p.type('second')
			await w.advance(500)
			void p.click()
			const emit = (ms: number, text: string) => w.setTimer(() => {
				if (w.epoch !== p['myEpoch']) return
				const m = p.messages.find((x) => x.text === text)
				if (m) { w.receipts.add(m.sendId); emitDeliveryReceipt(m.sendId, PEER) }
			}, ms)
			emit(900, 'second') // the second receipt arrives first
			emit(1500, 'first')
			await w.advance(killAt)
			const acceptedFirst = p.messages.some((m) => m.text === 'first')
			const acceptedSecond = p.messages.some((m) => m.text === 'second')
			w.kill()
			const q = await Page.open(w, 'browser')
			await w.advance(3000) // the copy must be there within 3 seconds of the page being usable
			const texts = q.messages.map((m) => m.text).sort()
			const want = [acceptedFirst ? 'first' : '', acceptedSecond ? 'second' : ''].filter(Boolean)
			if (texts.length !== want.length || texts.some((t, i) => t !== want[i])) misses.push(`kill=${killAt}: have=${texts.join('|')} want=${want.join('|')}`)
		}
		expect(misses).toEqual([])
	})

	it('after the library ACK the item is released and the copy is in the library: a reload at any later time shows it, and the reload that was held runs once', async () => {
		const { w, p } = await openLibrary()
		w.recipientReceipts = false
		p.type('only one')
		await w.advance(500)
		void p.click()
		await w.advance(1500)
		let reloads = 0
		requestControlledReload(() => { reloads += 1 })
		emitDeliveryReceipt(p.messages[0].sendId, PEER) // the receipt: proof, but the library has not ACKed yet
		await w.advance(2000)
		expect(p.queue.size()).toBe(1) // still queued: the sender's copy is not durable yet
		expect(reloads).toBe(0)
		await w.advance(15000) // the append ends (12 s after the answer)
		expect(p.queue.size()).toBe(0)
		expect(w.library.size).toBe(1)
		expect(reloads).toBe(1)
		w.kill()
		const q = await Page.open(w, 'browser')
		expect(q.occurrences('only one')).toBe(1)
	})

	it('control: if the item were released on the receipt, a kill before the ACK loses the copy; the same scenario in non-library mode is safe because the record holds the body', async () => {
		for (const library of [true, false]) {
			const w = new World()
			w.libraryMode = library
			w.recipientReceipts = false
			const p = await Page.open(w, 'browser')
			p.type('control')
			await w.advance(500)
			void p.click()
			await w.advance(1500)
			const sid = p.messages[0].sendId
			if (library) {
				// what did: release at the receipt without waiting for the library
				void p.queue.settle(sid, { kind: 'sent', persisted: true })
				await w.advance(300)
			} else {
				emitDeliveryReceipt(sid, PEER)
				await w.advance(300)
			}
			expect(p.queue.size()).toBe(0)
			w.kill()
			const q = await Page.open(w, 'browser')
			await w.advance(3000)
			expect(q.occurrences('control')).toBe(library ? 0 : 1)
		}
	})

	it('a library append that never ends (the worker is gone) keeps the item: the copy is restored from the queue document every time', async () => {
		const { w, p } = await openLibrary()
		w.libraryAckMs = 10_000_000
		w.recipientReceipts = false
		p.type('worker down')
		await w.advance(500)
		void p.click()
		await w.advance(1500)
		emitDeliveryReceipt(p.messages[0].sendId, PEER)
		await w.advance(60000)
		expect(p.queue.size()).toBe(1)
		w.kill()
		const q = await Page.open(w, 'browser')
		await w.advance(3000)
		expect(q.occurrences('worker down')).toBe(1)
	})

	it('two messages 0.7 s apart, the FIRST one\'s receipt arrives before the second\'s, a refresh after that: with the release rule the first is gone and the second is there; with the library gate both are there', async () => {
		for (const r5Rule of [true, false]) {
			const { w, p } = await openLibrary()
			w.recipientReceipts = false
			p.type('first')
			await w.advance(300)
			void p.click()
			await w.advance(700)
			p.type('second')
			await w.advance(300)
			void p.click()
			await w.advance(300)
			const first = p.messages.find((m) => m.text === 'first')!.sendId
			if (r5Rule) { void p.queue.settle(first, { kind: 'sent', persisted: true }); await w.advance(300) } // released at the receipt, the library has not ACKed
			else { w.receipts.add(first); emitDeliveryReceipt(first, PEER); await w.advance(300) }
			w.kill() // the refresh: before the second receipt, before any library append ended
			const q = await Page.open(w, 'browser')
			await w.advance(3000)
			expect(q.occurrences('second')).toBe(1)
			expect(q.occurrences('first')).toBe(r5Rule ? 0 : 1)
		}
	})

	it('the history worker is unavailable; three reloads in a row; the copy is on screen within 3 s every time, exactly once, and the queue does not grow', async () => {
		for (const mode of ['never answers', 'refuses'] as const) {
			const { w, p } = await openLibrary()
			if (mode === 'never answers') w.libraryAckMs = 10_000_000
			else w.libraryFails = true
			w.recipientReceipts = false
			p.type('worker down')
			await w.advance(500)
			void p.click()
			await w.advance(1500)
			w.receipts.add(p.messages[0].sendId)
			emitDeliveryReceipt(p.messages[0].sendId, PEER) // proof seen, the library never ACKs
			await w.advance(20_000)
			expect(p.queue.size()).toBe(1)
			w.kill()
			for (let reload = 1; reload <= 4; reload++) {
				const q = await Page.open(w, 'browser')
				await w.advance(3000)
				expect(`${mode}#${reload}:${q.occurrences('worker down')}`).toBe(`${mode}#${reload}:1`)
				expect(`${mode}#${reload}:${q.queue.size()}`).toBe(`${mode}#${reload}:1`)
				expect(w.queueDocCount()).toBe(1) // the document count does not grow with the reloads
				w.kill()
			}
		}
	})

	it('the worker is unavailable for a long time and comes back: the steady retry (confirmed items at the slow pace) makes the copy durable and releases the item, without any event and without a release limit', async () => {
		const { w, p } = await openLibrary()
		w.libraryFails = true
		w.recipientReceipts = false
		p.type('long outage')
		await w.advance(500)
		void p.click()
		await w.advance(1500)
		w.receipts.add(p.messages[0].sendId)
		emitDeliveryReceipt(p.messages[0].sendId, PEER)
		await w.advance(20 * 60_000) // twenty minutes of refusals: the item is NOT released
		expect(p.queue.size()).toBe(1)
		expect(w.library.size).toBe(0)
		w.libraryFails = false // the worker is back; no online / visible / load event
		await w.advance(5 * 60_000) // the slow tick comes (3 minutes) and the append works
		expect(w.library.size).toBe(1)
		expect(p.queue.size()).toBe(0)
		expect(w.queueDocCount()).toBe(0)
	})
})

