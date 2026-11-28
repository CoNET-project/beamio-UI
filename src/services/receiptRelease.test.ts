/**
 * @jest-environment node
 */
// What releases a queue item, what does not, and what a tap on a failed bubble does to it. The real queue, queue store, receipt evidence, delivery receipt bus, merge and tap controller. Code level: the conversation
// page is not rendered. Synthetic values.
import { createChatDocStores } from './chatDocStores'
import { createSendQueue, type AttemptResult, type QueueDocAdapter } from './sendQueue'
import { releaseDecisionOf } from './releaseDecision'
import { emitDeliveryReceipt } from './deliveryReceiptBus'
import { persistBatchReceipts, persistReceiptEvidence } from './receiptEvidence'
import { bubbleRetryPlan, tapFailedBubble } from './failedRetry'
import { makeMessage } from './chatMessageMerge'
import { markDeliveredFrom, mergeOwnRowIntoCurrent } from './chatRowMerge'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}
const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xbbbb000000000000000000000000000000000002'
const STRANGER = '0xcccc000000000000000000000000000000000003'

function world() {
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	const stores = createChatDocStores({ eoa: EOA, privateKey: `0x${'33'.repeat(32)}`, nativeShell: false, doc })!
	const queue = createSendQueue({ store: stores.queueStore, peer: PEER, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	return { stores, queue }
}
/** an item whose POST has already gone out once: armor stored, an empty 200 recorded, and then a later attempt failed */
async function attempted(w: ReturnType<typeof world>, sendId: string, wire?: string) {
	await w.queue.enqueue({ v: 1, sendId, peer: PEER, text: wire ? '' : 'synthetic text', ...(wire ? { wire } : {}), createdAt: 1, queuedAt: 1 }, { inline: true })
	await w.queue.run(sendId, async () => {
		await (await w.queue.armorContext(sendId))!.record(`armor-of-${sendId}`, 'digest')
		await w.queue.recordReceipt(sendId, 'legacy_empty')
		return { kind: 'awaiting', persisted: true }
	}, { inline: true })
	await w.queue.run(sendId, async () => ({ kind: 'failed' }))
}

describe('a tap on a failed bubble whose POST has already gone out keeps the item, its sendId, payload and armor', () => {
	it.each([
		['a reply', { reply: { messageId: 'x', replyType: 'paymentRequestPaid' } }, false],
		['a payment card', { paymentCard: { amount: 1 } }, false],
		['a call record', { callRecord: {} }, false],
		['a payment card with its stored payload', { paymentCard: { amount: 1 } }, true],
		['a reply with its stored payload', { reply: { messageId: 'x' } }, true],
		['a file without its payload', { fileMessage: {} }, false],
	])('%s', async (_name, extra, withWire) => {
		const w = world()
		const wire = withWire ? JSON.stringify({ sendId: 's1', ...extra }) : undefined
		await attempted(w, 's1', wire)
		const row = { from: 'me' as const, sendId: 's1', text: '', createdAt: 1, status: 'failed', ...extra }
		const plan = bubbleRetryPlan(row, w.queue.wireOf('s1'))
		let told = 0
		const posted: Array<string | undefined> = []
		const attempt = plan.kind === 'resend' ? async (): Promise<AttemptResult> => { posted.push((await w.queue.armorContext('s1'))!.armor, plan.wire); return { kind: 'awaiting', persisted: true } } : null
		await tapFailedBubble({ sendId: 's1', attempt, queue: w.queue, tellKept: () => { told += 1 } })
		expect(await w.stores.queueStore.get('s1')).toMatchObject({ sendId: 's1', armor: 'armor-of-s1', ...(wire ? { wire } : {}) })
		expect(w.queue.has('s1')).toBe(true)
		expect([told, posted]).toEqual(withWire ? [0, ['armor-of-s1', wire]] : [1, []])
		w.queue.dispose()
	})
})

describe('the status of a row releases nothing', () => {
	it('an answer without a bound receipt releases only with the receipt itself, from this contact, for this sendId', async () => {
		const w = world()
		const empty = { kind: 'legacy_empty' as const, digest: 'd' }
		const decide = (sendId: string) => releaseDecisionOf({ sendId, peer: PEER, receipt: empty, evidence: w.stores.receiptStore })
		expect(await decide('r1')).toBe('awaiting')
		emitDeliveryReceipt('r1', STRANGER)
		await w.stores.receiptStore.put(STRANGER, 'r1')
		await w.stores.receiptStore.put(PEER, 'r-other')
		expect(await decide('r1')).toBe('awaiting')
		await w.stores.receiptStore.put(PEER, 'r1')
		expect(await decide('r1')).toBe('confirmed')
		emitDeliveryReceipt('r2', PEER)
		expect(await decide('r2')).toBe('confirmed')
		w.queue.dispose()
	})
	it('a received message that claims to be the user\'s own and delivered, under the same sendId, neither changes the own row nor counts as one', () => {
		const forged = JSON.stringify({ sendId: 'r1', from: 'me', status: 'delivered', text: 'synthetic', createdAt: 5 })
		const mine = { id: 'tmp_1', sendId: 'r1', from: 'me' as const, text: 'synthetic own', createdAt: 1, status: 'sent' as const }
		const kept = makeMessage([mine] as ChatMessage[], forged, 5, 'them', 'sent')
		expect(kept.filter((m) => m.from === 'me')).toEqual([mine])
		const alone = makeMessage([], forged, 5, 'them', 'sent')
		expect(alone.map((m) => m.from)).toEqual(['them'])
		// and when both rows meet in one conversation row, the own message keeps its own status
		const merged = mergeOwnRowIntoCurrent({ address: PEER, messages: [mine] }, { address: PEER, messages: alone }) as { messages: Array<{ from: string; status: string }> }
		expect(merged.messages.filter((m) => m.from === 'me').map((m) => m.status)).toEqual(['sent'])
		// the only mark takes the sender of the receipt: another contact marks nothing
		expect(markDeliveredFrom([{ address: PEER, messages: [mine] }], 'r1', STRANGER).updated).toBe(false)
	})
	it('the page asks for the own row only, and no path releases on the status (source check)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src: string = require('fs').readFileSync(require('path').join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(src).toContain("const m = (messagesRef.current || []).find(x => x.sendId === item.sendId && x.from === 'me')")
		expect(src).toContain("if (m.status === 'sent' || m.status === 'delivered') {")
		expect(src).not.toContain("if (m.status === 'delivered') return { kind: 'sent'")
		expect(src).not.toContain('alreadyDelivered')
		expect(src).toContain('const decision = await releaseDecisionOf({ sendId: proofSid')
		expect(src).toContain('return tapFailedBubble({')
	})
})

describe('a delivery receipt and an account change', () => {
	it.each(['before the step', 'during the step'])('the account changes %s: every receipt line is held (not acknowledged)', async (when) => {
		const w = world()
		await attempted(w, 's1')
		let current = when === 'before the step' ? 'B' : 'A'
		let looked = 0
		const r = await persistBatchReceipts({
			receiptLines: ['line-1'],
			stillTheBatchAccount: () => current === 'A',
			step: async () => {
				looked += 1
				current = 'B' // by the time the lookup answers, the other account is current: its queue has no such item
				const step = await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'line-1' }], queueDoc: async () => ({ kind: 'absent' }), store: w.stores.receiptStore })
				return { heldLines: step.held.map((h) => h.line as string) }
			},
		})
		expect([r.heldLines, looked]).toEqual([['line-1'], when === 'before the step' ? 0 : 1])
		w.queue.dispose()
	})
	it('with the same account the step decides', async () => {
		expect(await persistBatchReceipts({ receiptLines: ['a'], stillTheBatchAccount: () => true, step: async () => ({ heldLines: [] }) })).toEqual({ heldLines: [] })
	})
	it('the page binds the step and the re-feed of a held line to the account of the batch (source check)', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const app: string = require('fs').readFileSync(require('path').join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toContain('async () => persistBatchReceipts({ receiptLines: batchDelivered.map((b) => b.line), stillTheBatchAccount, step: async () => {')
		expect(app).toContain("const batchAccount = String((profile as { keyID?: string }).keyID || '').toLowerCase()")
		expect(app).toContain('if (!stillTheBatchAccount()) continue')
		expect(app).not.toContain('markMessageDeliveredBySendId')
	})
})
