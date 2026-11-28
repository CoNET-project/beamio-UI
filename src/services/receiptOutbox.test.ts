/**
 * @jest-environment node
 */
// The recipient's delivery receipt is not sent just once: it is recorded as pending and sent again until the send succeeds. The sender side is the REAL send queue and queue store; the network is a double.
// Code-level reproduction only (synthetic keys and ids); no browser, no real mailbox.
import { createReceiptOutbox, noteRedeliveredLine, RECEIPT_OUTBOX_PREFIX } from './receiptOutbox'
import { classifySendAnswer } from './sendAnswer'
import { routeArrivedLine } from './inboundRowRecord'
import { base64JsonCodec } from './chatDraftStore'
import { createQueueStore, createSendQueue, type QueueDocAdapter } from './sendQueue'
import { isChatAuxDocId, WIPED_ON_RESET_PREFIXES } from './chatAuxDocs'
import { inboundMirrorFor } from './inboundMirror'
import { newInboundLists, recordInboundLine, settleInputOf } from './inboundRowRecord'
import { settleInboundBatch } from './inboundBatchSettle'
import { resetDurablePendingForTest } from './inboundDurable'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const ALICE = '0xaaaa000000000000000000000000000000000001' // sender of the message
const BOB = '0xbbbb000000000000000000000000000000000002' // recipient A on the receiving device
const CAROL = '0xcccc000000000000000000000000000000000003' // a second wallet on the receiving device
const KEY_B = `0x${'11'.repeat(32)}`
const KEY_C = `0x${'22'.repeat(32)}`
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)) }

function table() {
	const docs = new Map<string, string>()
	const removed: string[] = []
	const doc: QueueDocAdapter = {
		read: async (id) => docs.get(id) ?? null,
		put: async (id, t) => { docs.set(id, t) },
		remove: async (id) => { removed.push(id); docs.delete(id) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort(),
	}
	return { docs, removed, doc }
}

/** a manual clock with timers */
function clock() {
	let now = 1_000_000
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => { const h = { at: now + ms, fn, live: true }; timers.push(h); return h },
		clearTimer: (h: unknown) => { (h as { live: boolean }).live = false },
		live: () => timers.filter((t) => t.live).map((t) => t.at - now),
		/** advance by ms, firing due timers in order */
		advance: async (ms: number) => {
			const end = now + ms
			for (;;) {
				await settle()
				const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
				if (!due) break
				now = Math.max(now, due.at); due.live = false; due.fn()
			}
			now = end
			await settle()
		},
	}
}

function outboxOf(t: ReturnType<typeof table>, c: ReturnType<typeof clock>, send: (e: { sendId: string; to: string }) => Promise<boolean>, who: { eoa: string; key: string | '' } = { eoa: BOB, key: KEY_B }, alive: () => boolean = () => true) {
	return createReceiptOutbox({ eoa: who.eoa, privateKey: who.key, nativeShell: false, doc: t.doc, send, alive, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })!
}

describe('the sender stays "awaiting confirmation" only until the receipt gets through', () => {
	it('the recipient\'s receipt POST is blocked: the sender waits (a manual retry changes nothing); once unblocked the receipt is sent again, the sender ends delivered, the recipient still has ONE message', async () => {
		const c = clock()
		// sender: the real queue; the entry answers an empty 200 (accepted, no proof), and the mailbox keeps identical armor once
		const sender = table()
		const mailbox = new Set<string>()
		const received: string[] = []
		const queue = createSendQueue({ store: createQueueStore({ eoa: ALICE, doc: sender.doc, codec: base64JsonCodec() }), peer: BOB, resume: async () => post(), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
		let delivered = false
		let blocked = true
		const receiver = table()
		const posts: number[] = []
		const outbox = outboxOf(receiver, c, async (e) => {
			posts.push(c.now())
			if (blocked) return false
			// the receipt reaches the sender: its page marks the message delivered and releases the queue item
			delivered = true
			await queue.settle(e.sendId, { kind: 'sent', persisted: true })
			return true
		})
		const post = async () => {
			if (!mailbox.has('armor-m1')) { mailbox.add('armor-m1'); received.push('m1'); void outbox.add('m1', ALICE) }
			return { kind: 'awaiting', persisted: true } as const
		}
		await queue.enqueue({ v: 1, sendId: 'm1', peer: BOB, text: 'synthetic', createdAt: 1, queuedAt: 1 }, { inline: true })
		await queue.run('m1', post, { inline: true })
		await c.advance(20_000)
		await queue.run('m1', post) // the user taps Retry
		await settle()
		expect(queue.stateOf('m1')).toBe('awaiting')
		expect(delivered).toBe(false)
		blocked = false
		await c.advance(10 * 60_000)
		expect(delivered).toBe(true)
		expect(queue.has('m1')).toBe(false)
		expect(received).toEqual(['m1'])
		const done = posts.length
		await c.advance(60 * 60_000)
		outbox.kick(); await c.advance(60_000)
		expect(posts.length).toBe(done) // a completed item never sends again
		expect(receiver.removed).toEqual([]) // and is never removed
		expect([...receiver.docs.keys()]).toHaveLength(1)
	})

	it('a receipt that was SKIPPED (the sender\'s key or route is not verified yet) is sent later, also after a restart', async () => {
		const c = clock(); const t = table()
		let verified = false
		const sent: string[] = []
		const send = async (e: { sendId: string; to: string }) => { if (!verified) return false; sent.push(`${e.sendId}>${e.to}`); return true }
		const first = outboxOf(t, c, send)
		await first.add('m2', ALICE)
		await c.advance(1_000)
		first.dispose() // the page is closed
		verified = true
		const second = outboxOf(t, c, send)
		await second.load()
		await c.advance(6 * 60_000)
		expect(sent).toEqual([`m2>${ALICE}`])
		const third = outboxOf(t, c, send)
		await third.load()
		await c.advance(60 * 60_000)
		expect(sent).toHaveLength(1)
	})
})

describe('scenario C of the browser localisation (only the recipient\'s POSTs are blocked for 35 s)', () => {
	/** every receipt POST fails while blocked; the sender is delivered as soon as one gets through */
	function run(c: ReturnType<typeof clock>, t: ReturnType<typeof table>) {
		const start = c.now()
		const w = { delivered: null as number | null, failed: 0 }
		const send = async () => { if (c.now() - start < 35_000) { w.failed += 1; return false } w.delivered ??= c.now() - start; return true }
		return { w, start, send, outbox: outboxOf(t, c, send) }
	}
	it('with no resend and no tap: the timer alone gets the receipt through, at the 80 s step', async () => {
		const c = clock(); const t = table(); const { w, outbox } = run(c, t)
		await outbox.add('m-c', ALICE)
		await c.advance(35_000)
		expect(w.delivered).toBeNull()
		expect(w.failed).toBe(3) // 0 s, 5 s, 20 s
		await c.advance(60_000)
		expect(w.delivered).toBe(80_000)
	})
	it('the sender\'s message arriving again after the block brings it forward', async () => {
		const c = clock(); const t = table(); const { w, outbox } = run(c, t)
		await outbox.add('m-c', ALICE)
		await c.advance(40_000)
		noteRedeliveredLine(outbox, ALICE, 'm-c', [])
		await c.advance(2_000)
		expect(w.delivered).toBe(40_000)
	})
	it('a hard reload during the block keeps it pending, and it goes at the start of the next page once the block is over', async () => {
		const c = clock(); const t = table(); const first = run(c, t)
		await first.outbox.add('m-c', ALICE)
		await c.advance(10_000)
		first.outbox.dispose()
		await c.advance(40_000)
		const sent: string[] = []
		const second = outboxOf(t, c, async (e) => { sent.push(e.sendId); return true })
		await second.load()
		await c.advance(1_000)
		expect(sent).toEqual(['m-c'])
	})
})

describe('a receipt answered as successful and lost: the sender\'s resend gets it again', () => {
	/** the entry that takes the POST, answers an empty 200 and delivers nothing while `losing` */
	function world(c: ReturnType<typeof clock>, t: ReturnType<typeof table>) {
		const w = { losing: true, posts: [] as number[], got: 0 }
		const send = async () => {
			w.posts.push(c.now())
			// the published verdict of an empty 200: the send counts as successful although nothing is proven
			const ok = classifySendAnswer('', `0x${'cd'.repeat(32)}`) === 'legacy_empty'
			if (!w.losing) w.got += 1
			return ok
		}
		return { w, send, outbox: outboxOf(t, c, send) }
	}
	const chats = [{ address: ALICE, messages: [{ from: 'them', sendId: 'm-lost' }, { from: 'me', sendId: 'mine' }] }]
	/** the second arrival as the page routes it: handled before (marker / seen), so only the replay branch sees it */
	const arrivesAgain = (outbox: ReturnType<typeof outboxOf>, sendId = 'm-lost', signer = ALICE) => {
		const line = JSON.stringify({ from: signer, timestamp: 5, text: JSON.stringify({ sendId, text: 'synthetic' }), signMessage: 'sig' })
		expect(routeArrivedLine(line, { key: sendId, marked: true, seen: true })).toBe('already_handled')
		noteRedeliveredLine(outbox, signer, sendId, chats)
	}

	it('empty 200: marked done and not repeated by itself; the message arrives again and the receipt goes again, until it gets through; the message is not added twice', async () => {
		const c = clock(); const t = table(); const { w, outbox } = world(c, t)
		await outbox.add('m-lost', ALICE)
		await c.advance(60 * 60_000)
		expect(w.posts).toHaveLength(1)
		expect(w.got).toBe(0)
		w.losing = false
		arrivesAgain(outbox)
		await c.advance(60_000)
		expect(w.posts).toHaveLength(2)
		expect(w.got).toBe(1)
		expect(t.docs.size).toBe(1)
		expect(t.removed).toEqual([])
	})
	it('after a hard reload (a new outbox over the same documents) a done receipt still goes again on the next arrival', async () => {
		const c = clock(); const t = table(); const first = world(c, t)
		await first.outbox.add('m-lost', ALICE)
		await c.advance(10_000)
		first.outbox.dispose()
		const second = world(c, t); second.w.losing = false
		await second.outbox.load()
		await c.advance(60_000)
		expect(second.w.posts).toHaveLength(0)
		arrivesAgain(second.outbox)
		await c.advance(60_000)
		expect(second.w.got).toBe(1)
	})
	it('the resend is on disk before it is posted: closing the page before the POST leaves it pending', async () => {
		const c = clock(); const t = table(); const first = world(c, t)
		await first.outbox.add('m-lost', ALICE)
		await c.advance(100)
		await first.outbox.redelivered('m-lost', ALICE, true) // inside the 5 s gap: not posted yet
		expect(first.w.posts).toHaveLength(1)
		first.outbox.dispose()
		const second = world(c, t); second.w.losing = false
		await second.outbox.load()
		await c.advance(60_000)
		expect(second.w.got).toBe(1)
	})
	it('a storm of redeliveries is paced: at most one POST per 5 s for one receipt', async () => {
		const c = clock(); const t = table(); const { w, outbox } = world(c, t)
		await outbox.add('m-lost', ALICE)
		await c.advance(100)
		for (let i = 0; i < 200; i++) { arrivesAgain(outbox); await c.advance(100) } // 20 s
		const gaps = w.posts.slice(1).map((v, i) => v - w.posts[i]!)
		expect(gaps.every((g) => g >= 5_000)).toBe(true)
		expect(w.posts.length).toBeLessThanOrEqual(6)
		expect(w.posts.length).toBeGreaterThanOrEqual(2)
	})
	it('the message arrives again WHILE its receipt is being posted: one more send follows, paced, and it survives a page closed before it', async () => {
		const c = clock(); const t = table()
		const posts: number[] = []
		let release!: (ok: boolean) => void
		let hold = true
		const outbox = outboxOf(t, c, async () => { posts.push(c.now()); return hold ? new Promise<boolean>((r) => { release = r }) : true })
		await outbox.add('m-lost', ALICE)
		await c.advance(10)
		expect(posts).toHaveLength(1)
		noteRedeliveredLine(outbox, ALICE, 'm-lost', chats) // during the POST
		await c.advance(10)
		hold = false
		release(true)
		await c.advance(100)
		expect(posts).toHaveLength(1)
		await c.advance(60_000)
		expect(posts).toHaveLength(2)
		expect(posts[1]! - posts[0]!).toBeGreaterThanOrEqual(5_000)
		await c.advance(60 * 60_000)
		expect(posts).toHaveLength(2)
		// the same, closed before the second send: the record is still pending on disk
		const d = table(); let go!: (ok: boolean) => void; let first = true
		const one = outboxOf(d, c, async () => (first ? new Promise<boolean>((r) => { go = r }) : true))
		await one.add('m-lost', ALICE); await c.advance(10)
		noteRedeliveredLine(one, ALICE, 'm-lost', chats); await c.advance(10)
		first = false; go(true); await c.advance(100); one.dispose()
		const sent: string[] = []
		const two = outboxOf(d, c, async (e) => { sent.push(e.sendId); return true })
		await two.load(); await c.advance(60_000)
		expect(sent).toEqual(['m-lost'])
	})
	it('a stored message with no record (received before this page kept records) gets one on its next arrival', async () => {
		const c = clock(); const t = table(); const { w, outbox } = world(c, t); w.losing = false
		arrivesAgain(outbox)
		await c.advance(60_000)
		expect(w.got).toBe(1)
		expect(t.docs.size).toBe(1)
	})
	it('nothing is sent for a line this account holds no message of: a receipt frame, an own message, another peer, a record kept for another address', async () => {
		const c = clock(); const t = table(); const { w, outbox } = world(c, t)
		arrivesAgain(outbox, 'a-receipt-frame')
		arrivesAgain(outbox, 'mine')
		arrivesAgain(outbox, 'm-lost', CAROL)
		noteRedeliveredLine(outbox, ALICE, null, chats)
		await c.advance(60_000)
		expect(w.posts).toHaveLength(0)
		expect(t.docs.size).toBe(0)
		await outbox.add('m-lost', ALICE)
		await c.advance(60_000)
		await outbox.redelivered('m-lost', CAROL, true)
		await c.advance(60_000)
		expect(w.posts).toHaveLength(1)
	})
})

describe('account isolation', () => {
	it('records are per account and sealed: another wallet on the device sends nothing of them; switching stops the retries; back on the account they resume', async () => {
		const c = clock(); const t = table()
		const sentBy: string[] = []
		let current = BOB
		const a = outboxOf(t, c, async () => { sentBy.push('bob'); return false }, { eoa: BOB, key: KEY_B }, () => current === BOB)
		await a.add('secret-send-id', ALICE)
		await c.advance(1_000)
		const stored = [...t.docs.entries()]
		expect(stored).toHaveLength(1)
		const [id, body] = stored[0]!
		expect(id.startsWith(`${RECEIPT_OUTBOX_PREFIX}${BOB}:`)).toBe(true)
		for (const plain of ['secret-send-id', ALICE.slice(2)]) { expect(id).not.toContain(plain); expect(body).not.toContain(plain); expect(Buffer.from(body, 'base64').toString('utf8')).not.toContain(plain) }
		const before = sentBy.length
		current = CAROL; a.dispose()
		const other = outboxOf(t, c, async () => { sentBy.push('carol'); return true }, { eoa: CAROL, key: KEY_C }, () => current === CAROL)
		await other.load(); other.kick()
		await c.advance(60 * 60_000)
		expect(sentBy.length).toBe(before)
		current = BOB
		const back = outboxOf(t, c, async () => { sentBy.push('bob-again'); return true }, { eoa: BOB, key: KEY_B }, () => current === BOB)
		await back.load()
		await c.advance(60_000)
		expect(sentBy.slice(before)).toEqual(['bob-again'])
	})

	it('a timer that fires after the account changed (not yet disposed) sends nothing', async () => {
		const c = clock(); const t = table()
		let current = BOB
		let calls = 0
		const a = outboxOf(t, c, async () => { calls += 1; return false }, { eoa: BOB, key: KEY_B }, () => current === BOB)
		await a.add('m3', ALICE)
		await c.advance(1_000)
		const n = calls
		current = CAROL
		await c.advance(60 * 60_000)
		a.kick(); await c.advance(60_000)
		expect(calls).toBe(n)
	})

	it('a browser page without its key creates no outbox and writes nothing', () => {
		const t = table()
		expect(createReceiptOutbox({ eoa: BOB, privateKey: '', nativeShell: false, doc: t.doc, send: async () => true, alive: () => true })).toBeNull()
		expect(t.docs.size).toBe(0)
	})
})

describe('retry pacing', () => {
	it('with the receipt blocked for a day: the intervals grow to a cap of 5 minutes and stay there; online / visible / start-up kicks never make a fast loop', async () => {
		const c = clock(); const t = table()
		const at: number[] = []
		const o = outboxOf(t, c, async () => { at.push(c.now()); return false })
		await o.add('m4', ALICE)
		await c.advance(60 * 60_000)
		const gaps = at.slice(1).map((v, i) => v - at[i]!)
		expect(Math.max(...gaps)).toBe(300_000)
		expect(gaps.slice(-5)).toEqual([300_000, 300_000, 300_000, 300_000, 300_000])
		expect(gaps.every((g) => g >= 5_000)).toBe(true)
		const n = at.length
		for (let i = 0; i < 500; i++) o.kick()
		await c.advance(100)
		expect(at.length - n).toBeLessThanOrEqual(1)
		for (let i = 0; i < 200; i++) { o.kick(); await c.advance(50) } // 10 s of event storm
		expect(at.length - n).toBeLessThanOrEqual(3)
	})

	it('many pending receipts at start-up are not posted in one burst, and only one send runs at a time', async () => {
		const c = clock(); const t = table()
		const seed = outboxOf(t, c, async () => false)
		for (let i = 0; i < 20; i++) await seed.add(`bulk-${i}`, ALICE)
		seed.dispose()
		await c.advance(10 * 60_000)
		let running = 0; let most = 0
		const at: number[] = []
		const o = outboxOf(t, c, async () => { running += 1; most = Math.max(most, running); at.push(c.now()); await Promise.resolve(); running -= 1; return false })
		await o.load()
		await c.advance(5_000)
		expect(most).toBe(1)
		expect(at.length).toBeLessThanOrEqual(6)
		const gaps = at.slice(1).map((v, i) => v - at[i]!)
		expect(gaps.every((g) => g >= 1_000)).toBe(true)
	})

	it('a send that throws counts as not sent', async () => {
		const c = clock(); const t = table()
		let n = 0
		const o = outboxOf(t, c, async () => { n += 1; if (n < 3) throw new Error('boom'); return true })
		await o.add('m5', ALICE)
		await c.advance(10 * 60_000)
		expect(n).toBe(3)
	})

	it('the new documents are outside what the page may remove and outside the reset wipe (nothing new is ever deleted)', () => {
		expect(isChatAuxDocId(`${RECEIPT_OUTBOX_PREFIX}${BOB}:x`)).toBe(false)
		expect(WIPED_ON_RESET_PREFIXES.some((p) => RECEIPT_OUTBOX_PREFIX.startsWith(p))).toBe(false)
	})
})

describe('App.tsx wiring of a second arrival (source check)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const app: string = require('fs').readFileSync(require('path').join(__dirname, '../App.tsx'), 'utf8')
	it('the replay branch (verified lines only) and a duplicate row both ask for the receipt again; the outbox sends past the page\'s own "already sent" memory', () => {
		const verify = app.indexOf('const replaySigner = inboundSignerOf(')
		const refuse = app.indexOf('if (!replaySigner) continue', verify)
		const ask = app.indexOf('noteRedeliveredLine(nativeReceiptPath() ? null : receiptOutboxFor(), replaySigner.signer, extractInboundSendId(replaySigner.displayText), profiles?.[0]?.chats)')
		expect(verify).toBeGreaterThan(0)
		expect(refuse).toBeGreaterThan(verify)
		expect(ask).toBeGreaterThan(refuse)
		expect(app).toContain('if (!rowIsNew && receiptSendId && receiptTo) void receiptOutboxFor()?.redelivered(receiptSendId, receiptTo, true)')
		expect(app).toContain('return sendDeliveryReceiptToSender({ resend: true,')
	})
})

describe('App.tsx wiring (source check)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const app: string = require('fs').readFileSync(require('path').join(__dirname, '../App.tsx'), 'utf8')
	it('the receipt is recorded before any key read or request, and the one-shot path no longer sends it when the outbox holds it', () => {
		const add = app.indexOf('if (receiptOutbox && inboundSendId) void receiptOutbox.add(inboundSendId, signAddr)')
		expect(add).toBeGreaterThan(0)
		expect(add).toBeLessThan(app.indexOf("let senderPgp = nextChat.chatData?.publicArmored || ''"))
		expect(app).toContain('sendId: receiptOutbox ? null : inboundSendId,')
	})
	it('one attempt is false for a skip, goes only to the verified key and route, and only for the current account', () => {
		expect(app).toContain('if (!pk || nativeReceiptPath() || !nodes.length || historyAccountNow() !== account) return false')
		expect(app).toContain('if (!to.ok || historyAccountNow() !== account) return false')
		expect(app).toContain('alive: () => historyAccountNow() === account, send: (entry) => sendPendingReceipt(account, entry)')
	})
	it('leaving the account stops its retries; start, network back, page visible and entry nodes ready load or kick', () => {
		expect(app).toMatch(/receiptOutboxRef\.current\?\.outbox\.dispose\(\)\s*\n\s*receiptOutboxRef\.current = null\s*\n\s*\}\s*\n\s*\}, \[historyEoa, receiptOutboxFor\]\)/)
		expect(app).toContain('held?.outbox.dispose()')
		expect(app).toContain("window.addEventListener('online', kick)")
		expect(app).toContain("document.addEventListener('visibilitychange', onVisible)")
		expect(app).toContain('useEffect(() => { if (allNodes?.length) receiptOutboxRef.current?.outbox.kick() }, [allNodes])')
	})
})

describe('the pending receipt is on disk BEFORE the mailbox is acknowledged', () => {
	const H = `0x${'ab'.repeat(32)}`
	/** one inbound message line the way the page takes it: its mirror (history append, plus the receipt record) and the real settle step */
	async function inbound(outbox: ReturnType<typeof outboxOf>, acks: string[], isNew = true) {
		const released = new Set<string>()
		const lists = newInboundLists()
		recordInboundLine(lists, 'line-1', isNew, {
			mirror: () => inboundMirrorFor({ browser: true, isNew, peer: ALICE, added: { sendId: 'm-ack' }, ack: async () => true, fireAndForget: () => undefined, alsoRequire: () => outbox.add('m-ack', ALICE) }),
			write: () => undefined,
		})
		let stop = false
		await settleInboundBatch(settleInputOf(lists), {
			target: { browser: true, alreadyAcked: () => false, ackMailbox: (h) => { acks.push(...h) }, ackDisplayed: () => undefined },
			hashesOf: (ls) => ls.filter((l) => !released.has(l)).map(() => H),
			markHashes: (h) => h, unmarkHashes: () => undefined, commit: async () => true,
			release: (ls) => ls.forEach((l) => released.add(l)),
			durableOptions: { sleep: () => new Promise((r) => setTimeout(r, 2)), waitMs: 200, backoffMs: [2], alive: () => !stop },
		})
		return { stop: () => { stop = true } }
	}
	const real = () => new Promise((r) => setTimeout(r, 40))

	it('while the record cannot be written (a failing or slow store) there is NO mailbox ACK; once it is on disk the ACK goes, and a page killed right after still has the receipt', async () => {
		resetDurablePendingForTest()
		const c = clock(); const t = table()
		let writable = false
		const store: QueueDocAdapter = { ...t.doc, put: async (id, text) => { if (!writable) throw new Error('persist_failed'); t.docs.set(id, text) } }
		const first = outboxOf({ ...t, doc: store }, c, async () => false)
		const acks: string[] = []
		const run = await inbound(first, acks)
		await real()
		expect(acks).toEqual([])
		expect(t.docs.size).toBe(0)
		writable = true
		await real()
		expect(acks).toEqual([H])
		expect(t.docs.size).toBe(1)
		run.stop(); first.dispose() // killed after the ACK
		const sent: string[] = []
		const after = outboxOf({ ...t, doc: store }, c, async (e) => { sent.push(e.sendId); return true })
		await after.load(); await c.advance(60_000)
		expect(sent).toEqual(['m-ack'])
	})

	it('a redelivered copy (a duplicate row) also needs the record: a kill before the first write is repaired by the redelivery', async () => {
		resetDurablePendingForTest()
		const c = clock(); const t = table()
		const o = outboxOf(t, c, async () => true)
		const acks: string[] = []
		const run = await inbound(o, acks, false)
		await real(); await c.advance(10_000)
		expect(acks).toEqual([H])
		expect(t.docs.size).toBe(1)
		run.stop()
	})
})

describe('App.tsx wiring of the order (source check)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const app: string = require('fs').readFileSync(require('path').join(__dirname, '../App.tsx'), 'utf8')
	it('every inbound message line with a sendId (new or redelivered) hands the receipt record to its mirror; a browser without an outbox does not pass', () => {
		expect(app).toContain('return inboundMirrorFor({ alsoRequire: receiptRecorded, browser: inboundAckIsBrowser(),')
		expect(app).toContain('return outbox ? outbox.add(receiptSendId, receiptTo) : !inboundAckIsBrowser()')
		expect(app).not.toMatch(/receiptRecorded = [^\n]*rowIsNew/)
	})
})
