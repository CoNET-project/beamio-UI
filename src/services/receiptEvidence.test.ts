/**
 * @jest-environment node
 */
// the delivery receipt as durable evidence (receiptEvidence.ts) and its place in the inbound batch and in the conversation.
import { readFileSync } from 'fs'
import { join } from 'path'
import { base64JsonCodec, type DraftCodec } from './chatDraftStore'
import { createQueueStore, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { RECEIPT_ORPHAN_MAX_AGE_MS, RECEIPT_ORPHAN_MAX_COUNT, createReceiptStore, persistReceiptEvidence, receiptDocId, receiptDocPrefix, sendTagOfReceiptDocId } from './receiptEvidence'
import { settleInboundBatch, type InboundBatchSettleDeps } from './inboundBatchSettle'
import { docTaggerFor, mayCleanChatDocs, queueCodecFor } from './sendQueueCodec'
import { UNREADABLE_PERMANENT_MS, createUnreadableTracker, newReceiptHoldStats } from './receiptHold'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const OTHER = '0xdddd000000000000000000000000000000000004'
const item = (sendId: string, peer = PEER): QueueItem => ({ v: 1, sendId, peer, text: 'BODY-TEXT', createdAt: 1, queuedAt: 1 })

function disk() {
	const docs = new Map<string, string>()
	const log: string[] = []
	let failPut: ((id: string) => boolean) | null = null
	let failRemove: ((id: string) => boolean) | null = null
	let failRead: ((id: string) => boolean) | null = null
	const adapter: QueueDocAdapter = {
		read: async (id) => { if (failRead?.(id)) throw new Error('read_failed'); return docs.get(id) ?? null },
		put: async (id, t) => { if (failPut?.(id)) throw new Error('persist_failed'); log.push(`put:${id}`); docs.set(id, t) },
		remove: async (id) => { if (failRemove?.(id)) throw new Error('remove_failed'); log.push(`remove:${id}`); docs.delete(id) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort(),
	}
	return { docs, adapter, log, failPut: (f: typeof failPut) => { failPut = f }, failRemove: (f: typeof failRemove) => { failRemove = f }, failRead: (f: typeof failRead) => { failRead = f } }
}
const codec = (): DraftCodec => base64JsonCodec()
const tags = docTaggerFor('-----SYNTHETIC TAG KEY ARMOR-----', EOA)
/** the old all-or-nothing reading of the step: true when no receipt is held */
const persistOk = async (input: Parameters<typeof persistReceiptEvidence>[0]): Promise<boolean> => (await persistReceiptEvidence(input)).held.length === 0

// helpers: a healthy history append, and a pause for the background wait that runs after the settle step returns
const append = () => ({ done: Promise.resolve(true), retry: async () => true })
const settled = () => new Promise((r) => setTimeout(r, 25))

describe('what is written: only for a queue document that is on disk, only from its contact, nothing but ids and a time', () => {
	it('a receipt for a sendId with a queue document on disk from the item\'s contact is written; one without a queue document, or from another contact, is not (nobody fills the store with arbitrary sendIds)', async () => {
		const d = disk()
		const queueStore = createQueueStore({ eoa: EOA, doc: d.adapter, codec: codec() })
		await queueStore.put(item('s1'))
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags, now: () => 5000 })
		const ok = await persistOk({
			receipts: [{ sendId: 's1', from: PEER.toUpperCase().replace('0X', '0x') }, { sendId: 'unknown', from: PEER }, { sendId: 's1', from: OTHER }, { sendId: '', from: PEER }],
			queueDoc: (sid) => queueStore.inspect(sid),
			store,
		})
		expect(ok).toBe(true)
		const ids = [...d.docs.keys()].filter((k) => k.startsWith('chat-receipt-v1:'))
		expect(ids).toEqual([receiptDocId(EOA, tags, PEER, 's1')])
		expect(await store.has(PEER, 's1')).toBe(true)
		expect(await store.has(PEER, 'unknown')).toBe(false)
		expect(await store.has(OTHER, 's1')).toBe(false)
	})
	it('the queue document is read from the DISK for every receipt (not from memory slots)', async () => {
		const reads: string[] = []
		const store = createReceiptStore({ eoa: EOA, doc: disk().adapter, codec: codec(), tags })
		await persistOk({ receipts: [{ sendId: 'a', from: PEER }, { sendId: 'b', from: PEER }], queueDoc: async (sid) => { reads.push(sid); return { kind: 'absent' } }, store })
		expect(reads).toEqual(['a', 'b'])
	})
	it('the document holds sendId, peer and the arrival time: no text, no body, no key; the store decodes with the same codec as the queue (the shells\' is base64 JSON, not encryption)', async () => {
		const d = disk()
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags, now: () => 123456 })
		await store.put(PEER, 's1')
		const raw = [...d.docs.values()][0]
		const plain = JSON.parse(Buffer.from(raw.replace(/^B\./, ''), 'base64').toString('utf8') || '{}')
		expect(Object.keys(plain.receipt).sort()).toEqual(['at', 'peer', 'sendId', 'v'])
		expect(plain.receipt).toEqual({ v: 1, sendId: 's1', peer: PEER, at: 123456 })
		expect(JSON.stringify(plain)).not.toContain('BODY-TEXT')
	})
	it('a write that fails (or a queue document that cannot be read) makes the step fail: nothing is claimed as stored', async () => {
		const d = disk()
		const queueStore = createQueueStore({ eoa: EOA, doc: d.adapter, codec: codec() })
		await queueStore.put(item('s1'))
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		d.failPut((id) => id.startsWith('chat-receipt-v1:'))
		expect(await persistOk({ receipts: [{ sendId: 's1', from: PEER }], queueDoc: (s) => queueStore.inspect(s), store })).toBe(false)
		d.failPut(null)
		expect(await persistOk({ receipts: [{ sendId: 's1', from: PEER }], queueDoc: async () => { throw new Error('x') }, store })).toBe(false)
		expect(await persistOk({ receipts: [], queueDoc: async () => ({ kind: 'absent' }), store })).toBe(true)
	})
})

describe('the inbound batch: the receipt documents come first; a failed write means no marker, no ACK, no release', () => {
	// in the browser a chat row is ACKed ONLY by the wait for its history append (after the confirmed append); a drop line (receipt, control) is ACKed by the settle step. The doubles are like the page:
	// `release` clears the line from the pending map and `hashesOf` reads what is still pending.
	function deps(order: string[], over: Partial<InboundBatchSettleDeps> = {}): InboundBatchSettleDeps {
		const released = new Set<string>()
		return {
			target: { browser: true, alreadyAcked: () => false, ackMailbox: () => { order.push('ack') }, ackDisplayed: () => undefined },
			hashesOf: (lines) => lines.filter((l) => !released.has(l)).map((l) => `0x${l}`),
			markHashes: (h) => { order.push('mark'); return h },
			unmarkHashes: () => { order.push('unmark') },
			persistReceipts: async () => { order.push('receipts'); return { heldLines: [] } },
			commit: async () => { order.push('commit'); return true },
			release: (l) => { order.push('release'); l.forEach((x) => released.add(x)) },
			...over,
		}
	}
	it('the order is receipts, mark, commit, release, ack', async () => {
		const order: string[] = []
		expect(await settleInboundBatch({ rowLines: [], dropLines: ['r1'] }, deps(order))).toBe(true)
		expect(order).toEqual(['receipts', 'mark', 'commit', 'release', 'ack'])
	})
	it('a step that throws holds the receipt lines (or every drop line when none were named): no marker, no release, no ACK for them; the batch itself is committed', async () => {
		const order: string[] = []
		const released: string[] = []
		const d1 = deps(order, { persistReceipts: async () => { throw new Error('boom') }, release: (l) => { released.push(...l) } })
		expect(await settleInboundBatch({ rowLines: ['row'], dropLines: ['r1', 'ctl'], receiptLines: ['r1'] }, d1)).toBe(true)
		expect(released.sort()).toEqual(['ctl', 'row']) // is held; the other lines are settled
		const order2: string[] = []
		expect(await settleInboundBatch({ rowLines: ['row'], dropLines: ['r1', 'ctl'], durable: new Map([['row', append()]]) }, deps(order2, { persistReceipts: async () => { throw new Error('boom') } }))).toBe(true)
		await settled()
		// without receiptLines every drop line is held (no marker, no ACK for them); the row goes on: committed and released, and ACKed (after its marker) only by the wait for its append
		expect(order2).toEqual(['commit', 'release', 'mark', 'ack'])
	})
	it('per row: a held receipt line gets no marker, no release, no ACK, even when its armor hash is shared; the other lines of the same batch are marked, committed, released and ACKed; onHeld gets the held lines once, before the commit', async () => {
		const order: string[] = []
		const marked: string[] = []
		const acked: string[] = []
		const released: string[] = []
		const heldSeen: string[][] = []
		const releasedLines = new Set<string>()
		const ok = await settleInboundBatch({ rowLines: ['row'], dropLines: ['r-ok', 'r-held', 'r-held-twin'], durable: new Map([['row', append()]]) }, deps(order, {
			hashesOf: (lines) => lines.filter((l) => !releasedLines.has(l)).map((l) => (l === 'r-held-twin' ? '0xr-held' : `0x${l}`)),
			persistReceipts: async () => { order.push('receipts'); return { heldLines: ['r-held'] } },
			onHeld: (l) => { order.push('held'); heldSeen.push([...l]) },
			markHashes: (h) => { order.push('mark'); marked.push(...h); return h },
			release: (l) => { order.push('release'); released.push(...l); l.forEach((x) => releasedLines.add(x)) },
			target: { browser: true, alreadyAcked: () => false, ackMailbox: (h) => { order.push('ack'); acked.push(...h) }, ackDisplayed: () => undefined },
			commit: async () => { order.push('commit'); return true },
		}))
		await settled()
		expect(ok).toBe(true)
		// the settle step marks and ACKs the dropped receipt that was written (r-ok); the chat row is marked and ACKed afterwards, by the wait for its append
		expect(order).toEqual(['receipts', 'held', 'mark', 'commit', 'release', 'ack', 'mark', 'ack'])
		expect(heldSeen).toEqual([['r-held']])
		expect(released.sort()).toEqual(['r-held-twin', 'r-ok', 'row'].sort().filter((l) => l !== 'r-held-twin' || true).sort())
		expect(marked.sort()).toEqual(['0xr-ok', '0xrow'])
		expect(acked.sort()).toEqual(['0xr-ok', '0xrow'])
		expect(acked).not.toContain('0xr-held')
	})
	it('every receipt line held: nothing of theirs is marked or ACKed, the commit still runs (it carries the page state)', async () => {
		const order: string[] = []
		expect(await settleInboundBatch({ rowLines: [], dropLines: ['r1', 'r2'] }, deps(order, { persistReceipts: async () => ({ heldLines: ['r1', 'r2'] }) }))).toBe(true)
		expect(order).toEqual(['commit', 'release']) // no marker and no ACK: the only things left to do are the commit and an empty release
	})
	it('the commit fails after the receipts were written: the markers are rolled back, nothing is ACKed (the receipt documents stay: harmless and idempotent)', async () => {
		const order: string[] = []
		expect(await settleInboundBatch({ rowLines: [], dropLines: ['r1'] }, deps(order, { commit: async () => { order.push('commit'); return false } }))).toBe(false)
		expect(order).toEqual(['receipts', 'mark', 'commit', 'unmark'])
	})
	it('without receipts in the batch nothing changes', async () => {
		const order: string[] = []
		const d = deps(order)
		delete d.persistReceipts
		await settleInboundBatch({ rowLines: ['x'], dropLines: [], durable: new Map([['x', append()]]) }, d)
		await settled()
		expect(order).toEqual(['commit', 'release', 'mark', 'ack']) // the row: committed, released, then marked and ACKed by the wait for its append
	})
	it('App.tsx hands the batch\'s receipts to the step and builds the stores from the same codec as the conversation', () => {
		const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toMatch(/persistReceipts: batchDelivered\.length\s*\? async \(\) => persistBatchReceipts\([\s\S]*?persistReceiptEvidence\(\{\s*receipts: batchDelivered,\s*queueDoc: \(sid\) => queueStore\.inspect\(sid\)/)
		expect(app).toMatch(/const codecNow = queueCodecFor\(/)
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		const stores = readFileSync(join(__dirname, 'chatDocStores.ts'), 'utf8')
		expect(stores).toMatch(/const codec = queueCodecFor\(input\.privateKey\)/)
		expect(stores).toMatch(/const tags = docTaggerFor\(input\.privateKey, input\.eoa\)/)
		expect(chat).toMatch(/createChatDocStores\(\{ eoa, privateKey, nativeShell: isShellContext\(\)/)
	})
})

describe('reading: the document must agree with its key and contact; its existence alone is not evidence', () => {
	it('a document under the wrong key, for another contact, with another sendId, undecodable, or of another account is not evidence', async () => {
		const d = disk()
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		await store.put(PEER, 's1')
		expect(await store.has(PEER, 's1')).toBe(true)
		// plant a document whose content says another sendId under the key of s2
		const planted = createReceiptStore({ eoa: EOA, doc: { ...d.adapter, put: async (_id, t) => { d.docs.set(receiptDocId(EOA, tags, PEER, 's2'), t) } }, codec: codec(), tags })
		await planted.put(PEER, 'something-else')
		expect(await store.has(PEER, 's2')).toBe(false)
		// the same content under the key of another contact
		const plantedPeer = createReceiptStore({ eoa: EOA, doc: { ...d.adapter, put: async (_id, t) => { d.docs.set(receiptDocId(EOA, tags, OTHER, 's1'), t) } }, codec: codec(), tags })
		await plantedPeer.put(PEER, 's1') // content peer = PEER, key peer = OTHER
		expect(await store.has(OTHER, 's1')).toBe(false)
		d.docs.set(receiptDocId(EOA, tags, PEER, 's3'), 'not decodable')
		expect(await store.has(PEER, 's3')).toBe(false)
		const otherAccount = createReceiptStore({ eoa: OTHER, doc: d.adapter, codec: codec(), tags })
		expect(await otherAccount.has(PEER, 's1')).toBe(false)
		expect(receiptDocPrefix(EOA)).not.toBe(receiptDocPrefix(OTHER))
	})
	it('a disk read that throws is "no evidence", never an error and never a release', async () => {
		const d = disk()
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		await store.put(PEER, 's1')
		d.failRead(() => true)
		expect(await store.has(PEER, 's1')).toBe(false)
	})
	it('a second tab (another store on the same disk) sees what the first wrote: the disk is read on every entry', async () => {
		const d = disk()
		const tabA = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		const tabB = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		expect(await tabA.has(PEER, 's1')).toBe(false)
		await tabB.put(PEER, 's1')
		expect(await tabA.has(PEER, 's1')).toBe(true)
	})
	it('the conversation reads the disk on every resume entry and at load, and the mark-delivered / release order is queue document first, receipt document second', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/const evidenceOnDisk = evidenceInMemory \? false : \(await receiptStoreRef\.current\?\.has\(item\.peer, item\.sendId\)\.catch\(\(\) => false\)\) === true/)
		expect(chat).toMatch(/if \(entry === 'apply_evidence'\) return \{ kind: 'sent', persisted: await applyDeliveryReceiptRef\.current\(item\.sendId\) \}/)
		expect(chat).toMatch(/hasDeliveryReceipt\(it\.sendId, peer\) \|\| \(await receiptStore\.has\(peer, it\.sendId\)\.catch\(\(\) => false\)\)\) await applyDeliveryReceipt\(it\.sendId\)/)
		expect(chat).toMatch(/await queue\.settle\(sendId, \{ kind: 'sent', persisted \}\)[\s\S]{0,400}?if \(persisted && !queue\.has\(sendId\)\) await receiptStore\.remove\(peer, sendId\)/)
	})
	it('the release removes the receipt document only after the queue document: a kill in between leaves one orphan, never an item without its proof', async () => {
		// the model of applyDeliveryReceipt: settle (queue document removed) then remove the receipt document; kill after the first step
		const d = disk()
		const queueStore = createQueueStore({ eoa: EOA, doc: d.adapter, codec: codec() })
		const receipts = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags })
		await queueStore.put(item('s1'))
		await receipts.put(PEER, 's1')
		await queueStore.remove('s1') // step 1
		// killed here
		expect(await queueStore.get('s1')).toBeNull()
		expect(await receipts.has(PEER, 's1')).toBe(true) // an orphan receipt document
		// the other order would leave an item with no proof:
		const d2 = disk()
		const q2 = createQueueStore({ eoa: EOA, doc: d2.adapter, codec: codec() })
		const r2 = createReceiptStore({ eoa: EOA, doc: d2.adapter, codec: codec(), tags })
		await q2.put(item('s2'))
		await r2.put(PEER, 's2')
		await r2.remove(PEER, 's2') // wrong order, step 1
		expect(await q2.get('s2')).not.toBeNull()
		expect(await r2.has(PEER, 's2')).toBe(false) // proof lost
	})
})

describe('cleaning: only orphans, 7 days or 2000, oldest first; a receipt whose queue document exists is never removed', () => {
	it('orphans older than 7 days go; younger ones and receipts with a queue document stay, whatever their age', async () => {
		const d = disk()
		let t = 100 * 24 * 3600 * 1000
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags, now: () => t })
		const queueStore = createQueueStore({ eoa: EOA, doc: d.adapter, codec: codec() })
		await store.put(PEER, 'old-orphan', t - RECEIPT_ORPHAN_MAX_AGE_MS - 1000)
		await store.put(PEER, 'young-orphan', t - 1000)
		await store.put(PEER, 'old-with-queue', t - 30 * 24 * 3600 * 1000)
		await queueStore.put(item('old-with-queue'))
		const removed = await store.pruneOrphans({ queueSendIds: () => queueStore.rawSendIds() })
		expect(removed).toBe(1)
		expect(await store.has(PEER, 'old-orphan')).toBe(false)
		expect(await store.has(PEER, 'young-orphan')).toBe(true)
		expect(await store.has(PEER, 'old-with-queue')).toBe(true)
	})
	it('beyond 2000 orphans the oldest go first; 2500 receipts WITH queue documents are all kept', async () => {
		const d = disk()
		const t = 1_000_000_000
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags, now: () => t })
		const have = new Set<string>()
		for (let i = 0; i < RECEIPT_ORPHAN_MAX_COUNT + 5; i++) await store.put(PEER, `o${i}`, t - 10_000 + i) // young orphans, increasing age order by i
		const removed = await store.pruneOrphans({ queueSendIds: async () => [...have] })
		expect(removed).toBe(5)
		for (let i = 0; i < 5; i++) expect(await store.has(PEER, `o${i}`)).toBe(false) // the five oldest
		expect(await store.has(PEER, 'o5')).toBe(true)
		for (let i = 0; i < 2500; i++) { have.add(`o${i}`) }
		const again = await store.pruneOrphans({ queueSendIds: async () => [...have] })
		expect(again).toBe(0) // all have queue documents now: never removed by count
	})
	it('a document that cannot be read is an orphan (oldest); a failing removal does not stop the others; nothing else is touched', async () => {
		const d = disk()
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: codec(), tags, now: () => 1_000_000_000_000 })
		d.docs.set(receiptDocId(EOA, tags, PEER, 'broken'), 'not decodable')
		await store.put(PEER, 'a', 1)
		await store.put(PEER, 'b', 2)
		d.docs.set('chat-queue-v1:other:thing', 'x')
		d.failRemove((id) => id === receiptDocId(EOA, tags, PEER, 'a'))
		const removed = await store.pruneOrphans({ queueSendIds: async () => [] })
		expect(removed).toBe(2) // 'broken' and 'b' go (both older than 7 days); 'a' failed to remove and stays; the failure did not stop the others
		expect(d.docs.has(receiptDocId(EOA, tags, PEER, 'a'))).toBe(true)
		expect(d.docs.has(receiptDocId(EOA, tags, PEER, 'broken'))).toBe(false)
		expect(d.docs.has('chat-queue-v1:other:thing')).toBe(true)
	})
	it('the conversation prunes lazily when its queue loads, from the RAW queue records on disk', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/await readConversationQueue\(queue, queueStore,[\s\S]{0,1600}?void receiptStore\.pruneOrphans\(\{ queueSendIds: \(\) => queueStore\.rawSendIds\(\) \}\)/)
		expect(RECEIPT_ORPHAN_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000)
		expect(RECEIPT_ORPHAN_MAX_COUNT).toBe(2000)
	})
})

describe('codec and logging', () => {
	it('the queue and receipt documents use one codec helper: AES-GCM with a key, base64 JSON without (the shells)', async () => {
		const withKey = queueCodecFor('-----SYNTHETIC KEY ARMOR-----')
		const without = queueCodecFor('')
		expect(withKey.kind).toBe('aes-gcm')
		expect(without.kind).not.toBe('aes-gcm')
		const sealed = await withKey.encode('{"x":1}')
		expect(sealed).not.toContain('"x"')
		expect(await withKey.decode(sealed)).toBe('{"x":1}')
	})
	it('receiptEvidence.ts never logs', () => {
		const src = readFileSync(join(__dirname, 'receiptEvidence.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).not.toMatch(/console\.|qaLine|debugLog/)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// a queue document that exists but cannot be read is "not known", never "absent": the batch step fails and the line is not ACKed
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('unreadable is not absent', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR A1-----'
	it('inspect tells the three cases apart: no record, a readable item, a record that cannot be read (another codec, damage, the item of another sendId)', async () => {
		const d = disk()
		const sealed = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		await sealed.put(item('s1'))
		expect((await sealed.inspect('s1')).kind).toBe('item')
		expect(await sealed.inspect('nothing')).toEqual({ kind: 'absent' })
		// the same disk read through the codec of a page that has no key armor (base64 JSON): the record is there, it cannot be read
		const noKey = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('') })
		expect(await noKey.inspect('s1')).toEqual({ kind: 'unreadable' })
		expect(await noKey.get('s1')).toBeNull() // `get` cannot tell: that is why the receipt step must not use it
		// damage
		d.docs.set(`chat-queue-v1:${EOA}:broken`, 'not decodable')
		expect(await sealed.inspect('broken')).toEqual({ kind: 'unreadable' })
		// a record that decodes into an item of ANOTHER sendId is not this document
		d.docs.set(`chat-queue-v1:${EOA}:s9`, d.docs.get(`chat-queue-v1:${EOA}:s1`) as string)
		expect(await sealed.inspect('s9')).toEqual({ kind: 'unreadable' })
		// a disk that cannot be read throws
		d.failRead(() => true)
		await expect(sealed.inspect('s1')).rejects.toThrow()
	})
	it('a queue document that exists but cannot be read fails the step: nothing is stored for it, the other receipts of the batch do not hide it', async () => {
		const d = disk()
		const writer = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		await writer.put(item('s1'))
		await writer.put(item('s2'))
		const reader = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('') }) // privateKeyArmor missing: fell back to base64
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(''), tags: docTaggerFor('', EOA) })
		expect(await persistOk({ receipts: [{ sendId: 'gone', from: PEER }, { sendId: 's1', from: PEER }], queueDoc: (s) => reader.inspect(s), store })).toBe(false)
		expect(await persistOk({ receipts: [{ sendId: 's2', from: PEER }], queueDoc: (s) => reader.inspect(s), store })).toBe(false)
		expect([...d.docs.keys()].filter((k) => k.startsWith('chat-receipt-v1:'))).toEqual([])
		// the same batch with the right codec is stored
		const right = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: docTaggerFor(ARMOR, EOA) })
		expect(await persistOk({ receipts: [{ sendId: 's1', from: PEER }], queueDoc: (s) => writer.inspect(s), store: right })).toBe(true)
		expect(await right.has(PEER, 's1')).toBe(true)
	})
	it('codec mismatch in the other direction (written without a key, read with one) also fails the step; a genuinely absent document does not', async () => {
		const d = disk()
		await createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('') }).put(item('s1'))
		const reader = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: docTaggerFor(ARMOR, EOA) })
		expect(await persistOk({ receipts: [{ sendId: 's1', from: PEER }], queueDoc: (s) => reader.inspect(s), store })).toBe(false)
		expect(await persistOk({ receipts: [{ sendId: 'never-queued', from: PEER }], queueDoc: (s) => reader.inspect(s), store })).toBe(true)
	})
	it('in the batch an unreadable queue document holds ITS line only: no marker, no release, no ACK for it; the other lines of the batch are committed and ACKed', async () => {
		const d = disk()
		await createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) }).put(item('s1'))
		const reader = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('') })
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(''), tags: docTaggerFor('', EOA) })
		const order: string[] = []
		const acked: string[] = []
		const released1 = new Set<string>()
		const ok = await settleInboundBatch({ rowLines: ['row'], dropLines: ['r1'], durable: new Map([['row', append()]]) }, {
			target: { browser: true, alreadyAcked: () => false, ackMailbox: (h) => { order.push('ack'); acked.push(...h) }, ackDisplayed: () => undefined },
			hashesOf: (lines) => lines.filter((l) => !released1.has(l)).map((l) => `0x${l}`),
			markHashes: (h) => { order.push('mark'); return h },
			unmarkHashes: () => undefined,
			persistReceipts: async () => ({ heldLines: (await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'r1' }], queueDoc: (s) => reader.inspect(s), store })).held.map((h) => h.line as string) }),
			commit: async () => { order.push('commit'); return true },
			release: (l) => { order.push('release'); l.forEach((x) => released1.add(x)) },
		})
		await settled()
		expect(ok).toBe(true)
		expect(acked).toEqual(['0xrow']) // is not ACKed: the mailbox line comes again; the row is ACKed by the wait for its append
	})
	it('App.tsx: a batch with receipts and no account is false (not "nothing to write"), and the queue lookup is inspect (never get)', () => {
		const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toMatch(/if \(!eoaNow\) return \{ heldLines: receiptLines \}/)
		expect(app).not.toMatch(/if \(!eoaNow\) return \{ heldLines: \[\] \}/)
		const at = app.indexOf('persistReceipts: batchDelivered.length')
		const body = app.slice(at, at + 3200)
		expect(body).toContain('queueStore.inspect(sid)')
		expect(body).not.toContain('queueStore.get(')
		// the codec and the tags come from the same key armor, so the page that writes a receipt document and the conversation that reads it agree on bytes AND on the id
		expect(body).toContain('const codecNow = queueCodecFor(armorNow)')
		expect(body).toContain('const tagsNow = docTaggerFor(armorNow, eoaNow)')
		expect(body).toContain('tags: tagsNow')
	})
	it('the batch step never reads the queue document with `get` (receiptEvidence.ts only knows the lookup union)', () => {
		const src = readFileSync(join(__dirname, 'receiptEvidence.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).toMatch(/if \(found\.kind === 'unreadable'\) \{[\s\S]*?hold\(r, 'unreadable_wait'\)/)
		expect(src).not.toMatch(/queueStore\.get|\.get\(sid\)/)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the cleaner decides from the RAW queue records (by the sendTag in the key); unreadable is not absent there either
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('cleaning never deletes a receipt whose queue record still exists, readable or not', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR A2-----'
	const DAY = 24 * 3600 * 1000
	it('a queue document that cannot be read still protects its (old) receipt; with no queue record at all the same receipt goes', async () => {
		const d = disk()
		const t = 100 * DAY
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg, now: () => t })
		const q = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		await store.put(PEER, 'kept-unreadable-queue', t - 30 * DAY)
		await store.put(PEER, 'gone', t - 30 * DAY)
		d.docs.set(`chat-queue-v1:${EOA}:kept-unreadable-queue`, 'damaged') // present, cannot be decoded
		expect(await q.get('kept-unreadable-queue')).toBeNull() // what the old lookup saw: "absent"
		expect(await q.rawSendIds()).toEqual(['kept-unreadable-queue'])
		const removed = await store.pruneOrphans({ queueSendIds: () => q.rawSendIds() })
		expect(removed).toBe(1)
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'kept-unreadable-queue'))).toBe(true)
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'gone'))).toBe(false)
	})
	it('a receipt document that cannot be read is deleted ONLY when its queue record does not exist (the sendTag comes from the KEY)', async () => {
		const d = disk()
		const t = 100 * DAY
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg, now: () => t })
		d.docs.set(receiptDocId(EOA, tg, PEER, 'unreadable-with-queue'), 'damaged receipt')
		d.docs.set(receiptDocId(EOA, tg, PEER, 'unreadable-without-queue'), 'damaged receipt')
		const removed = await store.pruneOrphans({ queueSendIds: async () => ['unreadable-with-queue'] })
		expect(removed).toBe(1)
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'unreadable-with-queue'))).toBe(true)
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'unreadable-without-queue'))).toBe(false)
	})
	it('a receipt whose queue record exists survives the count limit too, whatever it holds', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg, now: () => 5 * DAY })
		const ids: string[] = []
		for (let i = 0; i < RECEIPT_ORPHAN_MAX_COUNT + 3; i++) { ids.push(`k${i}`); d.docs.set(receiptDocId(EOA, tg, PEER, `k${i}`), i % 2 ? 'damaged' : 'also damaged') }
		expect(await store.pruneOrphans({ queueSendIds: async () => ids })).toBe(0)
	})
	it('when the raw queue records cannot be listed (or a receipt cannot be read) nothing is removed: a failure is never "no queue record"', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg, now: () => 100 * DAY })
		await store.put(PEER, 'old', 1)
		await expect(store.pruneOrphans({ queueSendIds: async () => { throw new Error('list_failed') } })).rejects.toThrow('list_failed')
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'old'))).toBe(true)
		d.failRead((id) => id.startsWith('chat-receipt-v1:'))
		expect(await store.pruneOrphans({ queueSendIds: async () => [] })).toBe(0) // its age is not known: it stays
		expect(d.docs.has(receiptDocId(EOA, tg, PEER, 'old'))).toBe(true)
	})
	it('the sendTag of a key: the second part of prefix:peerTag:sendTag; a malformed id has none', () => {
		const tg = docTaggerFor(ARMOR, EOA)
		const id = receiptDocId(EOA, tg, PEER, 's1')
		expect(sendTagOfReceiptDocId(EOA, id)).toBe(tg.sendTag('s1'))
		expect(sendTagOfReceiptDocId(EOA, `${receiptDocPrefix(EOA)}only-one-part`)).toBeNull()
		expect(sendTagOfReceiptDocId(EOA, `${receiptDocPrefix(EOA)}a:b:c`)).toBeNull()
		expect(sendTagOfReceiptDocId(OTHER, id)).toBeNull()
	})
	it('chat.tsx hands the cleaner the RAW queue sendIds, never a decoded lookup', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/receiptStore\.pruneOrphans\(\{ queueSendIds: \(\) => queueStore\.rawSendIds\(\) \}\)/)
		expect(chat).not.toMatch(/queueDocExists/)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the ids carry keyed tags, not the contact address and not the sendId
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('no contact address and no sendId in the id of a receipt document', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR 6-----'
	const SEND_ID = 'send-id-with-readable-text-0001'
	it('the id is prefix:peerTag:sendTag; neither the address (any case, with or without 0x) nor the sendId appears in it, and the key armor does not either', async () => {
		const tg = docTaggerFor(ARMOR, EOA)
		const id = receiptDocId(EOA, tg, PEER, SEND_ID)
		const rest = id.slice(receiptDocPrefix(EOA).length)
		expect(rest).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}$/)
		for (const secret of [PEER, PEER.slice(2), PEER.toUpperCase(), SEND_ID, 'readable', ARMOR]) expect(id.toLowerCase()).not.toContain(secret.toLowerCase())
		expect(id.startsWith(`chat-receipt-v1:${EOA}:`)).toBe(true) // the account prefix stays (the account's documents are listed by it)
	})
	it('the tags are deterministic and case-insensitive for the contact, differ per contact, per sendId and per account key, and are keyed in the browser only', () => {
		const a = docTaggerFor(ARMOR, EOA)
		const again = docTaggerFor(ARMOR, EOA)
		expect(a.keyed).toBe(true)
		expect(again.peerTag(PEER)).toBe(a.peerTag(PEER))
		expect(a.peerTag(PEER.toUpperCase().replace('0X', '0x'))).toBe(a.peerTag(PEER))
		expect(a.peerTag(OTHER)).not.toBe(a.peerTag(PEER))
		expect(a.sendTag('s1')).not.toBe(a.sendTag('s2'))
		expect(a.sendTag('s1')).not.toBe(a.peerTag('s1')) // the label separates the two kinds of value
		const otherKey = docTaggerFor('-----ANOTHER ARMOR-----', EOA)
		expect(otherKey.peerTag(PEER)).not.toBe(a.peerTag(PEER))
		expect(otherKey.sendTag('s1')).not.toBe(a.sendTag('s1'))
		const shell = docTaggerFor('', EOA)
		expect(shell.keyed).toBe(false) // no key armor in a shell page: the tag is NOT secret, it only keeps the id from showing the address and the sendId
		expect(shell.peerTag(PEER)).not.toBe(a.peerTag(PEER))
		expect(docTaggerFor(undefined, EOA).peerTag(PEER)).toBe(shell.peerTag(PEER))
		expect(docTaggerFor('', OTHER).peerTag(PEER)).not.toBe(shell.peerTag(PEER))
	})
	it('the real peer and sendId are in the sealed body and are checked on every read: a body that names another sendId or contact under this tag is not evidence', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg })
		await store.put(PEER, SEND_ID)
		const [id] = [...d.docs.keys()]
		const body = JSON.parse((await queueCodecFor(ARMOR).decode(d.docs.get(id) as string)) as string) as { receipt: { sendId: string; peer: string } }
		expect(body.receipt.sendId).toBe(SEND_ID)
		expect(body.receipt.peer).toBe(PEER)
		expect(d.docs.get(id)).not.toContain(SEND_ID) // sealed in the browser
		expect((await store.get(PEER, SEND_ID))?.sendId).toBe(SEND_ID)
		// a body for another sendId planted under this tag key
		const other = createReceiptStore({ eoa: EOA, doc: { ...d.adapter, put: async (_i, t) => { d.docs.set(receiptDocId(EOA, tg, PEER, 'victim'), t) } }, codec: queueCodecFor(ARMOR), tags: tg })
		await other.put(PEER, 'another')
		expect(await store.has(PEER, 'victim')).toBe(false)
	})
	it('the documents of one contact are still listed by the deterministic prefix; the account key armor is only used in memory (no storage, no log)', () => {
		const src = readFileSync(join(__dirname, 'sendQueueCodec.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).not.toMatch(/console\.|localStorage|sessionStorage|debugLog|indexedDB/)
		const tg = docTaggerFor(ARMOR, EOA)
		const a = receiptDocId(EOA, tg, PEER, 's1')
		const b = receiptDocId(EOA, tg, PEER, 's2')
		expect(a.slice(0, a.lastIndexOf(':') + 1)).toBe(b.slice(0, b.lastIndexOf(':') + 1))
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the receipt evidence is checked BEFORE the two early returns of the resume; the release then needs only the message in the list and a persisted state
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('resumeSendRef checks the receipt evidence before its early returns', () => {
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	const at = chat.indexOf('resumeSendRef.current = async (item: QueueItem)')
	const body = chat.slice(at, chat.indexOf("if (m.status === 'delivered')", at))
	it('the receipt check (memory, then the disk) comes first; the chat-crypto guard and the "message not in the list" return come after it', () => {
		const receipt = body.indexOf('receiptStoreRef.current?.has(item.peer, item.sendId)')
		const noActions = body.indexOf("if (entry === 'chat_not_ready'")
		const noMessage = body.indexOf("|| entry === 'message_not_in_list'")
		expect(receipt).toBeGreaterThan(0)
		expect(noActions).toBeGreaterThan(receipt)
		expect(noMessage).toBeGreaterThan(receipt)
		expect(body).toMatch(/const entry = resumeEntryOf\(\{ evidenceInMemory, evidenceOnDisk, chatReady: !!chatActionsRef\.current, messageInList: !!m \}\)/)
		expect(body).toMatch(/if \(entry === 'apply_evidence'\) return \{ kind: 'sent', persisted: await applyDeliveryReceiptRef\.current\(item\.sendId\) \}/)
	})
	it('applying the evidence needs no chat crypto and no send: it is released only when the message is in the list AND its delivered state persisted (a missing message or a failed write is `false`)', () => {
		const a = chat.indexOf('const applyDeliveryReceipt = async (sendId: string): Promise<boolean> => {')
		const apply = chat.slice(a, chat.indexOf('applyDeliveryReceiptRef.current = applyDeliveryReceipt', a))
		expect(apply).not.toContain('chatActionsRef')
		expect(apply).toMatch(/if \(!m\) \{ recordReceiptOutcome\(sendId, peer, 'no_message'\); return false \}/)
		expect(apply).toMatch(/if \(!\(await markDeliveredDurable\(sendId\)\)\) \{ recordReceiptOutcome\(sendId, peer, 'delivered_mark_failed'\); return false \}/)
		expect(apply).toMatch(/await queue\.settle\(sendId, \{ kind: 'sent', persisted \}\)/)
	})
	it('a queue item whose receipt evidence is on disk but whose message is not in the list yet is NOT resent and not released: `sent, persisted false` keeps it as confirmed (only the persistence is retried)', async () => {
		const { createSendQueue } = await import('./sendQueue')
		const d = disk()
		const store = createQueueStore({ eoa: EOA, doc: d.adapter, codec: codec() })
		let posts = 0
		let inList = false
		const queue = createSendQueue({
			store,
			peer: PEER,
			isOnline: () => true,
			heartbeatMs: 0,
			resume: async () => { posts += 1; return { kind: 'failed' } },
			persistConfirmed: async () => inList,
		})
		await queue.enqueue(item('s1'))
		// the resume with evidence on disk answers `sent` with persisted = "the message is in the list and its state persisted" (applyDeliveryReceipt)
		await queue.run('s1', async () => ({ kind: 'sent', persisted: false }))
		expect(queue.has('s1')).toBe(true)
		expect(queue.stateOf('s1')).toBe('confirmed')
		inList = true
		await queue.run('s1', async () => { posts += 1; return { kind: 'failed' } }) // a confirmed item is never sent again: only persistConfirmed runs
		expect(posts).toBe(0)
		expect(queue.has('s1')).toBe(false)
		queue.dispose()
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the cleaners need the right key: a browser page that has no key armor yet (its first mount) sees every sealed document as foreign
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the cleaners run only with the right key', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR CLEANER-----'
	it('hazard: a keyless cleaner over keyed documents WOULD remove a receipt that has a queue record (its tag is foreign to it); mayCleanChatDocs forbids that run', async () => {
		const d = disk()
		const keyed = docTaggerFor(ARMOR, EOA)
		const keyless = docTaggerFor('', EOA)
		const q = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		const sealedReceipts = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: keyed, now: () => 100 * 24 * 3600 * 1000 })
		await q.put(item('s1'))
		await sealedReceipts.put(PEER, 's1', 1)
		const keylessCleaner = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(''), tags: keyless, now: () => 100 * 24 * 3600 * 1000 })
		expect(mayCleanChatDocs(keyless, false)).toBe(false) // the guard: this run never happens in a browser
		expect(await keylessCleaner.pruneOrphans({ queueSendIds: () => q.rawSendIds() })).toBe(1) // what it would have done
		expect(await sealedReceipts.has(PEER, 's1')).toBe(false)
	})
	it('keyed tags (a browser with its armor) and a native shell may clean; a browser without the armor may not', () => {
		expect(mayCleanChatDocs(docTaggerFor(ARMOR, EOA), false)).toBe(true)
		expect(mayCleanChatDocs(docTaggerFor('', EOA), true)).toBe(true)
		expect(mayCleanChatDocs(docTaggerFor('', EOA), false)).toBe(false)
		expect(mayCleanChatDocs(docTaggerFor(undefined, EOA), false)).toBe(false)
	})
	it('chat.tsx calls both cleaners only inside the guard', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		expect(chat).toMatch(/if \(mayCleanChatDocs\(tags, isShellContext\(\)\)\) \{\s*void deliveredStore\.prune\(\)\.catch\(\(\) => 0\)\s*void receiptStore\.pruneOrphans\(/)
		expect(chat.match(/deliveredStore\.prune\(/g)?.length).toBe(1)
		expect(chat.match(/receiptStore\.pruneOrphans\(/g)?.length).toBe(1)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// the step answers row by row; no key is a transient hold; an unreadable queue document is held on every reading (permanent ones only counted: no write, no ACK)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('the receipt step is row by row (a bad line stays pending; the rest of the batch goes on)', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR ROUND 2-----'
	function world() {
		const d = disk()
		const keyed = docTaggerFor(ARMOR, EOA)
		const writer = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: keyed })
		return { d, keyed, writer, store, stats: newReceiptHoldStats() }
	}
	it('no key (a browser): every receipt is held as no_key, nothing is read, nothing is written; the counter says so', async () => {
		const { d, writer, store, stats } = world()
		await writer.put(item('s1'))
		let reads = 0
		const r = await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L1' }, { sendId: 's2', from: PEER, line: 'L2' }], queueDoc: async (s) => { reads += 1; return writer.inspect(s) }, store, canReadSealed: false, stats })
		expect(r.held.map((h) => `${h.line}:${h.reason}`)).toEqual(['L1:no_key', 'L2:no_key'])
		expect(reads).toBe(0)
		expect([...d.docs.keys()].filter((k) => k.startsWith('chat-receipt-v1:'))).toEqual([])
		expect(stats).toMatchObject({ held: 2, heldNoKey: 2, heldUnreadable: 0, permanent: 0 })
	})
	it('an unreadable queue document with the key known is HELD on every reading, also once it is PERMANENT (three readings, or ten minutes): no receipt document is written, the line is never released for ACK; the permanent event is counted once per streak', async () => {
		const { d, writer, store, stats } = world()
		await writer.put(item('s1'))
		const reader = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('another key') }) // present, cannot be read
		const unreadable = createUnreadableTracker(() => 1)
		const step = () => persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L1' }], queueDoc: (s) => reader.inspect(s), store, unreadable, stats })
		for (let i = 0; i < 6; i++) {
			const r = await step()
			expect(r.held.map((h) => h.reason)).toEqual(['unreadable_wait'])
			expect(r.written).toBe(0)
		}
		expect([...d.docs.keys()].filter((k) => k.startsWith('chat-receipt-v1:'))).toEqual([])
		expect(await store.has(PEER, 's1')).toBe(false)
		expect(stats).toMatchObject({ held: 6, heldUnreadable: 6, permanent: 1 }) // counted once, not six times
	})
	it('the ten-minute rule counts as permanent too (and still holds); a readable reading ends the streak so the next streak counts again', async () => {
		const { d, writer, store } = world()
		await writer.put(item('s1'))
		const wrong = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('another key') })
		let now = 1000
		const unreadable = createUnreadableTracker(() => now)
		const stats = newReceiptHoldStats()
		const run = (reader: { inspect: (s: string) => ReturnType<typeof writer.inspect> }) => persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L' }], queueDoc: (s) => reader.inspect(s), store, unreadable, stats })
		await run(wrong)
		now += UNREADABLE_PERMANENT_MS - 1
		await run(wrong)
		expect(stats.permanent).toBe(0)
		now += 1
		expect((await run(wrong)).held.length).toBe(1)
		expect(stats.permanent).toBe(1)
		await run(writer) // readable: the streak ends (the receipt is written: the item is readable)
		await run(wrong); await run(wrong); await run(wrong)
		expect(stats.permanent).toBe(2) // a new streak, counted again
	})
	it('a receipt write that fails holds the line (write_failed) and writes nothing', async () => {
		const { d, writer, store } = world()
		await writer.put(item('s1'))
		d.failPut((id) => id.startsWith('chat-receipt-v1:'))
		const r = await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L1' }], queueDoc: (s) => writer.inspect(s), store, stats: newReceiptHoldStats() })
		expect(r.held.map((h) => h.reason)).toEqual(['write_failed'])
	})
	it('the only exit stays: a receipt is written only for a READABLE queue item of the same contact; an unreadable one never gets evidence, so the item is released only by a bound, readable receipt and a safely stored copy', async () => {
		const { d, writer, store } = world()
		await writer.put(item('s1', PEER))
		const wrong = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('another key') })
		for (let i = 0; i < 4; i++) await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L' }], queueDoc: (s) => wrong.inspect(s), store, unreadable: createUnreadableTracker(() => 1), stats: newReceiptHoldStats() })
		expect(await store.has(PEER, 's1')).toBe(false)
		// the same receipt from ANOTHER contact for a readable item: not written either
		const other = await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: OTHER, line: 'L2' }], queueDoc: (s) => writer.inspect(s), store, stats: newReceiptHoldStats() })
		expect(other.held).toEqual([])
		expect(other.written).toBe(0)
		expect(await store.has(OTHER, 's1')).toBe(false)
	})
	it('a mixed batch: the readable one is written, the unreadable one is held, the one without a queue document is not held; only the held line is reported', async () => {
		const { d, writer, store } = world()
		await writer.put(item('ok'))
		await writer.put(item('bad'))
		d.docs.set(`chat-queue-v1:${EOA}:bad`, 'damaged')
		const r = await persistReceiptEvidence({
			receipts: [{ sendId: 'ok', from: PEER, line: 'L-ok' }, { sendId: 'bad', from: PEER, line: 'L-bad' }, { sendId: 'none', from: PEER, line: 'L-none' }],
			queueDoc: (s) => writer.inspect(s),
			store,
			unreadable: createUnreadableTracker(() => 1),
			stats: newReceiptHoldStats(),
		})
		expect(r.held.map((h) => h.line)).toEqual(['L-bad'])
		expect(r.written).toBe(1)
		expect(await store.has(PEER, 'ok')).toBe(true)
	})
	it('end to end in the batch: one bad queue document holds one line; the other lines of the batch (a chat row, a second receipt) are marked, committed and ACKed', async () => {
		const { d, writer, store } = world()
		await writer.put(item('good'))
		await writer.put(item('bad'))
		d.docs.set(`chat-queue-v1:${EOA}:bad`, 'damaged')
		const acked: string[] = []
		const released: string[] = []
		const released2 = new Set<string>()
		const ok = await settleInboundBatch({ rowLines: ['row'], dropLines: ['r-good', 'r-bad'], durable: new Map([['row', append()]]) }, {
			target: { browser: true, alreadyAcked: () => false, ackMailbox: (h) => { acked.push(...h) }, ackDisplayed: () => undefined },
			hashesOf: (lines) => lines.filter((l) => !released2.has(l)).map((l) => `0x${l}`),
			markHashes: (h) => h,
			unmarkHashes: () => undefined,
			persistReceipts: async () => ({ heldLines: (await persistReceiptEvidence({ receipts: [{ sendId: 'good', from: PEER, line: 'r-good' }, { sendId: 'bad', from: PEER, line: 'r-bad' }], queueDoc: (s) => writer.inspect(s), store, unreadable: createUnreadableTracker(() => 1), stats: newReceiptHoldStats() })).held.map((h) => h.line as string) }),
			commit: async () => true,
			release: (l) => { released.push(...l); l.forEach((x) => released2.add(x)) },
		})
		await settled()
		expect(ok).toBe(true)
		expect(acked.sort()).toEqual(['0xr-good', '0xrow']) // the good receipt by the settle step, the chat row by the wait for its append
		expect(released.sort()).toEqual(['r-good', 'row'])
	})
})

describe('the tags are quasi-identifiers: not in a log line, not in the hook output', () => {
	it('the hook state line has no tag: no 32-hex group, no peerTag / sendTag / docTagger in qaAckOrder.ts', async () => {
		const src = readFileSync(join(__dirname, '../utils/qaAckOrder.ts'), 'utf8')
		expect(src).not.toMatch(/docTaggerFor|peerTag|sendTag|DocTagger|sendQueueCodec|receiptDocId|deliveredDocId/)
		jest.resetModules()
		process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
		const mod = await import('../utils/qaAckOrder')
		const tg = docTaggerFor('-----SYNTHETIC ARMOR FOR LINE-----', EOA)
		const tagsOfState = [tg.peerTag(PEER), tg.sendTag('1767225600000-aaaa1111')]
		const state = {
			chats: [], queueDocs: [receiptDocId(EOA, tg, PEER, 's1'), `chat-queue-v1:${EOA}:1767225600000-aaaa1111`], lock: { writing: false },
			queue: [{ sendId: '1767225600000-aaaa1111', state: 'awaiting', attempts: 2, confirmedSince: 0, lastAttemptAt: 5 }],
			kicks: [], confirmedUnbacked: { count: 0, oldestAgeMs: 0 }, receipts: [{ at: 7, id: 'aaaa1111', from: 'abcdef', outcome: 'applied' }], events: [], conversation: null,
			receiptHold: { held: 1, noKey: 0, unreadable: 1, disk: 0, permanent: 0 },
			transportFault: { mode: 'off', hits: 0 },
			receiveCounters: { totals: { arr: 1, dd: 0, ra: 0, re: 1, ro: 1, rf: 0, rk: 0, rn: 0 }, ids: [{ id: 'aaaa1111', arr: 1, dd: 0, ra: 0, re: 1, ro: 1, rf: 0, rk: 0, rn: 0 }] },
		}
		const line = mod.qaStateLine(state as never, 1)
		for (const t of tagsOfState) expect(line).not.toContain(t)
		expect(line).not.toMatch(/[0-9a-f]{32}/)
		delete process.env.REACT_APP_QA_ACK_ORDER_HOOK // (node environment: there is no window, so the hook global is never installed)
	})
	it('no source logs a document id or a tag: the three document modules, the codec and the step never log; the receipt trace has no tag', () => {
		for (const f of ['receiptEvidence.ts', 'deliveredMarks.ts', 'sendQueueCodec.ts', 'receiptHold.ts', 'chatDocStores.ts']) {
			const src = readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
			expect(src).not.toMatch(/console\.|debugLog|qaLine/)
		}
		const bus = readFileSync(join(__dirname, 'deliveryReceiptBus.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(bus).not.toMatch(/peerTag|sendTag|docTagger/)
	})
})

describe(' the product rule: the permanently unreadable ones are visible on their own, and the loop is bounded and counted', () => {
	it('stats.permanentActive follows the tracker (a gauge), stats.permanent counts streaks once; the QA line prints both (rh.p, rh.pa)', async () => {
		const ARMOR = '-----SYNTHETIC ARMOR FOR GAUGE-----'
		const d = disk()
		const writer = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR) })
		await writer.put(item('s1'))
		await writer.put(item('s2'))
		const wrong = createQueueStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('another key') })
		const store = createReceiptStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: docTaggerFor(ARMOR, EOA) })
		const tracker = createUnreadableTracker(() => 1)
		const stats = newReceiptHoldStats()
		const step = () => persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L1' }, { sendId: 's2', from: PEER, line: 'L2' }], queueDoc: (s) => wrong.inspect(s), store, unreadable: tracker, stats })
		for (let i = 0; i < 3; i++) await step()
		expect(stats).toMatchObject({ permanent: 2, permanentActive: 2, heldUnreadable: 6 })
		await persistReceiptEvidence({ receipts: [{ sendId: 's1', from: PEER, line: 'L1' }], queueDoc: (s) => writer.inspect(s), store, unreadable: tracker, stats }) // s1 became readable
		expect(stats.permanentActive).toBe(1)
		const qa = readFileSync(join(__dirname, '../utils/qaAckOrder.ts'), 'utf8')
		expect(qa).toMatch(/p: state\.receiptHold\.permanent, pa: state\.receiptHold\.permanentActive/)
	})
	it('the loop: a held line is put back into the normal path after 5 s, 15 s, 60 s and then EVERY 5 MINUTES for as long as the page lives; every pass is counted (held, heldUnreadable) so it never idles silently', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const hold = require('./receiptHold') as typeof import('./receiptHold')
		const t = hold.createHeldLineTracker()
		const delays = Array.from({ length: 8 }, () => t.hold('L').delayMs)
		expect(delays).toEqual([5_000, 15_000, 60_000, 300_000, 300_000, 300_000, 300_000, 300_000])
	})
})
