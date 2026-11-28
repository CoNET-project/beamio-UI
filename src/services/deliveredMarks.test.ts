/**
 * @jest-environment node
 */
// the delivered state of the sender's own messages in library mode (deliveredMarks.ts): its own small documents, a one-way upgrade sent -> delivered, kept by recency.
import { readFileSync } from 'fs'
import { join } from 'path'
import { base64JsonCodec } from './chatDraftStore'
import type { QueueDocAdapter } from './sendQueue'
import { DELIVERED_GLOBAL_MAX, DELIVERED_PER_PEER_MAX, applyDeliveredMarks, createDeliveredStore, deliveredDocId, deliveredDocPrefix, deliveredPeerPrefix } from './deliveredMarks'
import { libraryHoldsForClient } from './senderCopy'
import { docTaggerFor, queueCodecFor } from './sendQueueCodec'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const OTHER = '0xdddd000000000000000000000000000000000004'
const tags = docTaggerFor('-----SYNTHETIC TAG KEY ARMOR-----', EOA)

function disk() {
	const docs = new Map<string, string>()
	const reads: string[] = []
	let failPut = false
	let failRemove: ((id: string) => boolean) | null = null
	const adapter: QueueDocAdapter = {
		read: async (id) => { reads.push(id); return docs.get(id) ?? null },
		put: async (id, t) => { if (failPut) throw new Error('persist_failed'); docs.set(id, t) },
		remove: async (id) => { if (failRemove?.(id)) throw new Error('remove_failed'); docs.delete(id) },
		list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort(),
	}
	return { docs, adapter, reads, failPut: (v: boolean) => { failPut = v }, failRemove: (f: typeof failRemove) => { failRemove = f } }
}

describe('the documents', () => {
	it('put / loadFor: the sendIds of this contact with a consistent document; another contact\'s are not in it', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags, now: () => 7000 })
		await store.put(PEER, 's1')
		await store.put(PEER.toUpperCase().replace('0X', '0x'), 's2')
		await store.put(OTHER, 's3')
		expect([...(await store.loadFor(PEER))].sort()).toEqual(['s1', 's2'])
		expect([...(await store.loadFor(OTHER))]).toEqual(['s3'])
	})
	it('the content is sendId, peer, time: no text, nothing else; and it uses the queue codec (AES-GCM with a key, base64 JSON in a shell)', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags, now: () => 4242 })
		await store.put(PEER, 's1')
		const raw = [...d.docs.values()][0]
		const plain = JSON.parse(Buffer.from(raw.replace(/^B\./, ''), 'base64').toString('utf8') || '{}')
		expect(plain.delivered).toEqual({ v: 1, sendId: 's1', peer: PEER, at: 4242 })
		const aes = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor('-----SYNTHETIC KEY ARMOR-----'), tags })
		// a long unique marker: a two-character id like 's9' occurs in a random base64 ciphertext by chance (one run in the full tree failed on it)
		const marker = 'send-marker-that-must-not-appear-in-the-sealed-document-0123456789'
		await aes.put(PEER, marker)
		const sealed = d.docs.get(deliveredDocId(EOA, tags, PEER, marker)) as string
		expect(sealed).not.toContain(marker)
		expect((await aes.loadFor(PEER)).has(marker)).toBe(true)
	})
	it('a document that cannot be read, or whose content disagrees with its key or contact, is absent and raises nothing', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		await store.put(PEER, 's1')
		d.docs.set(deliveredDocId(EOA, tags, PEER, 'broken'), 'not decodable')
		// content of s1 under the key of s2 (same contact)
		d.docs.set(deliveredDocId(EOA, tags, PEER, 's2'), d.docs.get(deliveredDocId(EOA, tags, PEER, 's1')) as string)
		// content of PEER's s1 under the key of OTHER
		d.docs.set(deliveredDocId(EOA, tags, OTHER, 's1'), d.docs.get(deliveredDocId(EOA, tags, PEER, 's1')) as string)
		expect([...(await store.loadFor(PEER))]).toEqual(['s1'])
		expect([...(await store.loadFor(OTHER))]).toEqual([])
	})
	it('a failed write is an error for the caller (it releases nothing); a failing list is "no marks"', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		d.failPut(true)
		await expect(store.put(PEER, 's1')).rejects.toThrow()
		const bad = createDeliveredStore({ eoa: EOA, doc: { ...d.adapter, list: async () => { throw new Error('x') } }, codec: base64JsonCodec(), tags })
		expect([...(await bad.loadFor(PEER))]).toEqual([])
	})
	it('the file never logs', () => {
		const src = readFileSync(join(__dirname, 'deliveredMarks.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).not.toMatch(/console\.|qaLine|debugLog/)
		expect(deliveredDocPrefix(EOA)).toBe(`chat-delivered-v1:${EOA}:`)
	})
})

describe('the one-way upgrade', () => {
	const msgs = () => [
		{ id: 'm1', from: 'me', sendId: 's1', status: 'sent' },
		{ id: 'm2', from: 'me', sendId: 's2', status: 'sent' },
		{ id: 'm3', from: 'them', sendId: 's1', status: 'sent' },
		{ id: 'm4', from: 'me', sendId: 's4', status: 'delivered' },
		{ id: 'm5', from: 'me', sendId: 's5', status: 'read' },
		{ id: 'm6', from: 'me', sendId: 's1x', status: 'failed' },
		{ id: 'm7', from: 'me', sendId: 's7', status: 'sending' },
		{ id: 'm8', from: 'me', status: 'sent' },
	]
	it('every status BELOW delivered of the sender\'s own marked message becomes delivered (sent, failed, sending); delivered and read stay; the unmarked and the other side\'s are untouched', () => {
		const out = applyDeliveredMarks(msgs(), new Set(['s1', 's1x', 's7']))
		expect(out.map((m) => `${m.id}:${m.status}`)).toEqual(['m1:delivered', 'm2:sent', 'm3:sent', 'm4:delivered', 'm5:read', 'm6:delivered', 'm7:delivered', 'm8:sent'])
	})
	it('a read message is never lowered, whether or not it is marked; delivered stays delivered', () => {
		const out = applyDeliveredMarks([{ from: 'me', sendId: 'r', status: 'read' }, { from: 'me', sendId: 'd', status: 'delivered' }], new Set(['r', 'd']))
		expect(out.map((m) => m.status)).toEqual(['read', 'delivered'])
		const list = [{ from: 'me', sendId: 'r', status: 'read' }]
		expect(applyDeliveredMarks(list, new Set(['r']))).toBe(list) // nothing changed: the same array
	})
	it('a failed message with a delivered mark is raised to delivered (the recipient has it) and its send error is cleared; the held statuses are below delivered too', () => {
		const out = applyDeliveredMarks([
			{ from: 'me', sendId: 'f', status: 'failed', sendError: 'network' },
			{ from: 'me', sendId: 'h1', status: 'route_unconfirmed' },
			{ from: 'me', sendId: 'h2', status: 'first_fetch_pending' },
			{ from: 'me', sendId: 'h3', status: 'fingerprint_changed' },
		], new Set(['f', 'h1', 'h2', 'h3']))
		expect(out.map((m) => m.status)).toEqual(['delivered', 'delivered', 'delivered', 'delivered'])
		expect((out[0] as { sendError?: unknown }).sendError).toBeUndefined()
	})
	it('the other side\'s message with a marked sendId is not touched, at any status below delivered', () => {
		const list = [{ from: 'them', sendId: 's1', status: 'sent' }, { from: 'them', sendId: 's1', status: 'failed' }, { from: 'them', sendId: 's1', status: 'sending' }, { from: undefined, sendId: 's1', status: 'sent' }]
		expect(applyDeliveredMarks(list, new Set(['s1']))).toBe(list)
	})
	it('the order is the one of messageStatusOrder.ts: the rule is "rank below delivered", not a list of statuses; deliveredMarks.ts does not name sent / failed / read', () => {
		const src = readFileSync(join(__dirname, 'deliveredMarks.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(src).toMatch(/messageStatusRank\(m\.status\) < DELIVERED_RANK/)
		expect(src).toMatch(/import \{ messageStatusRank \} from '\.\/messageStatusOrder'/)
		expect(src).not.toMatch(/status === 'sent'|status === 'failed'|status === 'read'/)
	})
	it('the same array comes back when nothing changes (no state churn)', () => {
		const list = msgs()
		expect(applyDeliveredMarks(list, new Set())).toBe(list)
		expect(applyDeliveredMarks(list, new Set(['unrelated']))).toBe(list)
		expect(applyDeliveredMarks([], new Set(['s1']))).toEqual([])
	})
	it('the marks of one contact are read for that contact only (loadFor), so a sendId of another conversation cannot raise this one', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		await store.put(OTHER, 's1')
		const marks = await store.loadFor(PEER)
		expect(applyDeliveredMarks([{ from: 'me', sendId: 's1', status: 'sent' }], marks)[0].status).toBe('sent')
		expect(applyDeliveredMarks([{ from: 'me', sendId: 's1', status: 'failed' }], marks)[0].status).toBe('failed')
	})
})

describe('kept by recency: the newest 500 per contact, the newest 5000 in all, never by age', () => {
	it('the numbers', () => {
		expect(DELIVERED_PER_PEER_MAX).toBe(500)
		expect(DELIVERED_GLOBAL_MAX).toBe(5000)
	})
	it('under the limits nothing is read and nothing is removed, however old the marks are', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags, now: () => 1_000_000_000_000 })
		for (let i = 0; i < 20; i++) await store.put(PEER, `s${i}`, 1 + i) // ancient marks
		d.reads.length = 0
		expect(await store.prune()).toBe(0)
		expect(d.reads).toEqual([]) // the counts come from the ids
		expect((await store.loadFor(PEER)).size).toBe(20)
	})
	it('over the per-contact limit the oldest of THAT contact go; the other contact is untouched', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		for (let i = 0; i < 12; i++) await store.put(PEER, `p${i}`, 100 + i)
		for (let i = 0; i < 5; i++) await store.put(OTHER, `o${i}`, 1 + i)
		expect(await store.prune({ perPeerMax: 10, globalMax: 1000 })).toBe(2)
		const p = await store.loadFor(PEER)
		expect(p.has('p0')).toBe(false)
		expect(p.has('p1')).toBe(false)
		expect(p.has('p2')).toBe(true)
		expect((await store.loadFor(OTHER)).size).toBe(5)
	})
	it('over the global limit the oldest of all go (by time, across contacts)', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		for (let i = 0; i < 6; i++) await store.put(PEER, `p${i}`, 10 + i * 2)
		for (let i = 0; i < 6; i++) await store.put(OTHER, `o${i}`, 11 + i * 2)
		expect(await store.prune({ perPeerMax: 100, globalMax: 8 })).toBe(4)
		expect([...(await store.loadFor(PEER))].sort()).toEqual(['p2', 'p3', 'p4', 'p5'])
		expect([...(await store.loadFor(OTHER))].sort()).toEqual(['o2', 'o3', 'o4', 'o5'])
	})
	it('an unreadable document counts as the oldest and goes first; a failing removal does not stop the others', async () => {
		const d = disk()
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec(), tags })
		d.docs.set(deliveredDocId(EOA, tags, PEER, 'broken'), 'not decodable')
		for (let i = 0; i < 3; i++) await store.put(PEER, `p${i}`, 50 + i)
		d.failRemove((id) => id === deliveredDocId(EOA, tags, PEER, 'p0'))
		const removed = await store.prune({ perPeerMax: 2, globalMax: 1000 })
		expect(removed).toBe(1 + 0) // 4 documents, limit 2 -> 2 doomed; p0 failed to remove
		expect(d.docs.has(deliveredDocId(EOA, tags, PEER, 'broken'))).toBe(false)
		expect(d.docs.has(deliveredDocId(EOA, tags, PEER, 'p0'))).toBe(true)
		expect(d.docs.has(deliveredDocId(EOA, tags, PEER, 'p2'))).toBe(true)
	})
})

describe('in the conversation (chat.tsx)', () => {
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('the mark is written only in library mode, with the queue codec, and a failure is `false` (release nothing)', () => {
		expect(chat).toMatch(/const markDeliveredDurable = async \(sendId: string\): Promise<boolean> => \{\s*const store = deliveredStoreRef\.current\s*if \(!store \|\| \(!localChatLibraryCapable\(\) && isShellContext\(\)\)\) return true[^\n]*\n\s*if \(!\(await libraryHoldsNow\(\)\)\) return true/)
		expect(chat).toMatch(/await store\.put\(chatData\.address, sendId\)\s*\} catch \{\s*return false\s*\}/)
		expect(readFileSync(join(__dirname, 'chatDocStores.ts'), 'utf8')).toMatch(/deliveredStore: createDeliveredStore\(\{ eoa: input\.eoa, doc: input\.doc, codec, tags \}\)/)
		expect(chat).toMatch(/const \{ tags, queueStore, receiptStore, deliveredStore \} = stores/)
	})
	it('the mark is written in the same step as the delivered state, BEFORE the sender copy check, the queue release and the receipt document delete; a failed write returns false before any of them', () => {
		const at = chat.indexOf("if (!(await markDeliveredDurable(sendId))) { recordReceiptOutcome(sendId, peer, 'delivered_mark_failed'); return false }")
		expect(at).toBeGreaterThan(0)
		const after = chat.slice(at, at + 1400)
		const iPersist = after.indexOf('senderCopyPersisted(sendId')
		const iSettle = after.indexOf('queue.settle(sendId')
		const iRemove = after.indexOf('receiptStore.remove(peer, sendId)')
		expect(iPersist).toBeGreaterThan(0)
		expect(iSettle).toBeGreaterThan(iPersist)
		expect(iRemove).toBeGreaterThan(iSettle)
		// the status turned delivered in memory before the mark is written
		expect(chat.slice(at - 700, at)).toMatch(/status: 'delivered' as const/)
	})
	it('a message that is already delivered at resume gets its mark before the item is released', () => {
		expect(chat).not.toMatch(/if \(m\.status === 'delivered'\) return \{ kind: 'sent'/) // the row status is no evidence: only the receipt releases (receiptRelease.test.ts)
	})
	it('the marks of the contact are read and cleaned at load, and applied as a one-way upgrade when the list changes', () => {
		expect(chat).toMatch(/void deliveredStore\.loadFor\(peer\)\.then\(\(marks\) => \{ if \(!cancelled\) \{ deliveredMarksRef\.current = marks; setDeliveredTick\(\(t\) => t \+ 1\) \} \}\)/)
		expect(chat).toMatch(/void deliveredStore\.prune\(\)\.catch\(\(\) => 0\)/)
		expect(chat).toMatch(/const next = applyDeliveredMarks\(messages, deliveredMarksRef\.current\)\s*if \(next !== messages\) setMessages\(next\)/)
	})
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// keyed tags in the ids; a shell writes no delivered document
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('no contact address and no sendId in the id of a delivered document', () => {
	const ARMOR = '-----SYNTHETIC ARMOR FOR DELIVERED-----'
	const SEND_ID = 'send-id-with-readable-text-0002'
	it('the id is prefix:peerTag:sendTag, neither the address nor the sendId nor the armor appears in it; the sealed body names the real ones', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg })
		await store.put(PEER, SEND_ID)
		const [id] = [...d.docs.keys()]
		expect(id.slice(deliveredDocPrefix(EOA).length)).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}$/)
		for (const secret of [PEER, PEER.slice(2), PEER.toUpperCase(), SEND_ID, 'readable', ARMOR]) expect(id.toLowerCase()).not.toContain(secret.toLowerCase())
		const body = JSON.parse((await queueCodecFor(ARMOR).decode(d.docs.get(id) as string)) as string) as { delivered: { sendId: string; peer: string } }
		expect(body.delivered.sendId).toBe(SEND_ID)
		expect(body.delivered.peer).toBe(PEER)
		expect((await store.loadFor(PEER)).has(SEND_ID)).toBe(true)
	})
	it('the documents of one contact are listed by the deterministic prefix; another contact is another prefix; the per-contact limit counts by the contact tag in the id', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg })
		for (let i = 0; i < 4; i++) await store.put(PEER, `p${i}`, 100 + i)
		await store.put(OTHER, 'o0', 1)
		const peerPrefix = deliveredPeerPrefix(EOA, tg, PEER)
		expect((await d.adapter.list(peerPrefix)).length).toBe(4)
		expect((await d.adapter.list(deliveredPeerPrefix(EOA, tg, OTHER))).length).toBe(1)
		expect(await store.prune({ perPeerMax: 2, globalMax: 1000 })).toBe(2)
		expect([...(await store.loadFor(PEER))].sort()).toEqual(['p2', 'p3'])
		expect([...(await store.loadFor(OTHER))]).toEqual(['o0'])
	})
	it('a body for another sendId or contact under a tag key is absent (the key is checked against the body on every read)', async () => {
		const d = disk()
		const tg = docTaggerFor(ARMOR, EOA)
		const store = createDeliveredStore({ eoa: EOA, doc: d.adapter, codec: queueCodecFor(ARMOR), tags: tg })
		await store.put(PEER, 's1')
		d.docs.set(deliveredDocId(EOA, tg, PEER, 'victim'), d.docs.get(deliveredDocId(EOA, tg, PEER, 's1')) as string)
		d.docs.set(deliveredDocId(EOA, tg, OTHER, 's1'), d.docs.get(deliveredDocId(EOA, tg, PEER, 's1')) as string)
		expect([...(await store.loadFor(PEER))]).toEqual(['s1'])
		expect([...(await store.loadFor(OTHER))]).toEqual([])
	})
	it('chat.tsx builds the tags from the same key source as the codec (privateKey) and the account address', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		const stores = readFileSync(join(__dirname, 'chatDocStores.ts'), 'utf8')
		expect(stores).toMatch(/const tags = docTaggerFor\(input\.privateKey, input\.eoa\)/)
		expect(stores).toMatch(/const codec = queueCodecFor\(input\.privateKey\)/)
		expect(chat).toMatch(/createChatDocStores\(\{ eoa, privateKey, nativeShell: isShellContext\(\)/)
	})
})

describe('a shell (no library capability) writes no delivered document; a library client does', () => {
	const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
	it('markDeliveredDurable returns true without writing when the client is a shell without a library, before the mode is even read', () => {
		const at = chat.indexOf('const markDeliveredDurable = async')
		const body = chat.slice(at, chat.indexOf('const senderCopyPersisted', at))
		expect(body).toMatch(/if \(!store \|\| \(!localChatLibraryCapable\(\) && isShellContext\(\)\)\) return true/)
	})
	it('the pure decision: record-based and shell clients are not library mode, so libraryHoldsNow is false and nothing is written; only library and guarded browsers write', () => {
		expect(libraryHoldsForClient({ mode: 'library', capable: false, nativeShell: true })).toBe(false)
		expect(libraryHoldsForClient({ mode: 'record', capable: true, nativeShell: false })).toBe(false)
		expect(libraryHoldsForClient({ mode: 'library', capable: true, nativeShell: false })).toBe(true)
		expect(libraryHoldsForClient({ mode: 'guarded', capable: true, nativeShell: false })).toBe(true)
	})
})
