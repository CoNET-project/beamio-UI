/**
 * @jest-environment node
 */
// A lost request or a lost answer, on a SYNTHETIC network. Real: the sender's queue and queue store, the receipt evidence, the recipient's receipt outbox, the line routing and the redelivery rule.
// Doubles (assumptions, not evidence about any running node or device): the mailbox keeps one copy of identical armor while it is stored, delivers on every accepted POST, and stores it again after the
// recipient's ACK deleted it; the sender's resume and the recipient's row ledger are short replicas of what the pages do. Synthetic values.
import { createChatDocStores } from './chatDocStores'
import { createSendQueue, type AttemptResult, type QueueDocAdapter } from './sendQueue'
import { persistReceiptEvidence } from './receiptEvidence'
import { createReceiptOutbox, noteRedeliveredLine, type ReceiptOutbox } from './receiptOutbox'
import { routeArrivedLine } from './inboundRowRecord'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const tick = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)) }
function disk() {
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	return { docs, doc }
}
/** request: nothing reaches the node. answer: the node keeps and delivers it, the poster hears an error. swallowed: the poster hears success (an empty 200), the node keeps nothing. */
type Fault = 'none' | 'request' | 'answer' | 'swallowed'
type Leg = 'message' | 'receipt'

async function network(options: { oldRecipient?: boolean; ackDeletes?: boolean }) {
	const faults: Record<Leg, Fault[]> = { message: [], receipt: [] }
	const stored = new Set<string>()
	const rows: string[] = []
	const marked = new Set<string>()
	let clock = 0
	const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
	const a = disk(); const b = disk()
	const aStores = createChatDocStores({ eoa: A, privateKey: `0x${'33'.repeat(32)}`, nativeShell: false, doc: a.doc })!
	const newQueue = () => createSendQueue({ store: aStores.queueStore, peer: B, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [], now: () => clock })
	let queue = newQueue()
	let outbox: ReceiptOutbox
	let seen = new Set<string>()

	const post = async (leg: Leg, armor: string, deliver: () => Promise<void>): Promise<boolean> => {
		const fault = faults[leg].shift() ?? 'none'
		if (fault === 'request') return false
		if (fault === 'swallowed') return true
		stored.add(armor)
		await deliver()
		return fault !== 'answer'
	}
	/** the sender takes a receipt in: evidence on disk first, then the item of that sendId is released */
	const senderReceives = async (sendId: string) => {
		await persistReceiptEvidence({ receipts: [{ sendId, from: B }], queueDoc: (s) => aStores.queueStore.inspect(s), store: aStores.receiptStore })
		if (await aStores.receiptStore.has(B, sendId)) await queue.settle(sendId, { kind: 'sent', persisted: true })
	}
	const sendReceipt = (sendId: string) => post('receipt', `receipt-armor-${sendId}-${clock}`, () => senderReceives(sendId))
	const newOutbox = () => {
		outbox = createReceiptOutbox({ eoa: B, privateKey: `0x${'44'.repeat(32)}`, nativeShell: false, doc: b.doc, alive: () => true, send: (e) => sendReceipt(e.sendId), now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return t }, clearTimer: (h) => { (h as { live: boolean }).live = false } })!
		return outbox
	}
	newOutbox()
	const recipientTakes = async (sendId: string, armor: string) => {
		const line = JSON.stringify({ from: A, timestamp: 1, text: JSON.stringify({ sendId, text: 'synthetic' }), signMessage: 'synthetic', _beamioPgpArmorHash: armor })
		const route = routeArrivedLine(line, { key: sendId, marked: marked.has(line), seen: seen.has(sendId) })
		if (route === 'fresh') {
			seen.add(sendId)
			const isNew = !rows.includes(sendId)
			if (isNew) rows.push(sendId)
			if (options.oldRecipient) { if (isNew) void sendReceipt(sendId) } else await outbox.add(sendId, A)
			marked.add(line)
		} else if (!options.oldRecipient) noteRedeliveredLine(outbox, A, sendId, [{ address: A, messages: rows.map((id) => ({ from: 'them', sendId: id })) }])
		if (options.ackDeletes) stored.delete(armor)
	}
	const attempt = (sendId: string) => async (): Promise<AttemptResult> => {
		const ctx = (await queue.armorContext(sendId))!
		const armor = ctx.armor ?? `armor-${sendId}`
		if (!ctx.armor) await ctx.record(armor, 'digest')
		const ok = await post('message', armor, () => recipientTakes(sendId, armor))
		return ok ? { kind: 'awaiting', persisted: true } : { kind: 'failed' }
	}
	/** time passes: due timers of the recipient's outbox run */
	const pass = async (ms: number) => {
		const until = clock + ms
		for (;;) {
			await tick()
			const next = timers.filter((t) => t.live && t.at <= until).sort((x, y) => x.at - y.at)[0]
			if (!next) break
			next.live = false; clock = Math.max(clock, next.at); next.fn()
		}
		clock = until
		await tick()
	}
	const send = async (sendId: string) => {
		await queue.enqueue({ v: 1, sendId, peer: B, text: 'synthetic', createdAt: 1, queuedAt: 1 }, { inline: true })
		await queue.run(sendId, attempt(sendId), { inline: true })
		await pass(1_000)
	}
	const repost = async (sendId: string) => { if (queue.has(sendId)) await queue.run(sendId, attempt(sendId)); await pass(60_000) }
	return {
		faults, rows, send, repost, pass,
		pending: async () => (await aStores.queueStore.list()).map((i) => i.sendId),
		restartSender: async () => { queue.dispose(); queue = newQueue(); await queue.load() },
		restartRecipient: async () => { outbox.dispose(); seen = new Set(); newOutbox(); await outbox.load() },
		stop: () => { queue.dispose(); outbox.dispose() },
	}
}

const LOSSES: Array<[string, Leg, Fault]> = [
	['the message request is lost', 'message', 'request'],
	['the answer to the message is lost', 'message', 'answer'],
	['the message is answered with success and not kept', 'message', 'swallowed'],
	['the receipt request is lost', 'receipt', 'request'],
	['the answer to the receipt is lost', 'receipt', 'answer'],
	['the receipt is answered with success and not kept', 'receipt', 'swallowed'],
]
for (const ackDeletes of [true, false]) {
	describe(`recovery over the existing protocol (the mailbox ${ackDeletes ? 'deleted the message on the ACK' : 'still holds the message'})`, () => {
		it.each(LOSSES)('%s: the sender posts the same armor again, the recipient sends the receipt of that sendId again; one row, one release', async (_n, leg, fault) => {
			const net = await network({ ackDeletes })
			net.faults[leg].push(fault)
			await net.send('s1')
			for (let i = 0; i < 3; i++) await net.repost('s1')
			expect([await net.pending(), net.rows]).toEqual([[], ['s1']])
			net.stop()
		})
	})
}
it('several losses in a row, with both sides restarted in between, still end in one row and one release', async () => {
	const net = await network({ ackDeletes: true })
	net.faults.message.push('request', 'swallowed')
	net.faults.receipt.push('swallowed', 'swallowed', 'request')
	await net.send('s1')
	await net.restartSender(); await net.repost('s1')
	await net.restartRecipient()
	for (let i = 0; i < 6; i++) { await net.repost('s1'); if (i % 2) { await net.restartRecipient(); await net.restartSender() } }
	expect([await net.pending(), net.rows]).toEqual([[], ['s1']])
	net.stop()
})
it('a sender that does not post again stays pending: nothing else brings a swallowed receipt back', async () => {
	const net = await network({ ackDeletes: true })
	net.faults.receipt.push('swallowed')
	await net.send('s1')
	await net.pass(3_600_000)
	expect([await net.pending(), net.rows]).toEqual([['s1'], ['s1']])
	net.stop()
})
it('a recipient that sends its receipt only for a new message: once that receipt is lost, the sender stays pending whatever it posts', async () => {
	const net = await network({ ackDeletes: true, oldRecipient: true })
	net.faults.receipt.push('swallowed')
	await net.send('s1')
	for (let i = 0; i < 4; i++) { await net.repost('s1'); await net.restartRecipient() }
	expect([await net.pending(), net.rows]).toEqual([['s1'], ['s1']])
	net.stop()
})
