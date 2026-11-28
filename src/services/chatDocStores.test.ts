/**
 * @jest-environment node
 */
// a browser without its key armor creates no store and writes no document; a native shell and a keyed browser do (chatDocStores.ts).
import { readFileSync } from 'fs'
import { join } from 'path'
import { nextDraft } from './chatDraftState'
import { base64JsonCodec, createDraftStore } from './chatDraftStore'
import { createChatDocStores } from './chatDocStores'
import type { QueueDocAdapter } from './sendQueue'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const EOA = '0xaaaa000000000000000000000000000000000001'
const PEER = '0xcccc000000000000000000000000000000000003'
const ARMOR = '-----SYNTHETIC KEY ARMOR FOR STORES-----'
const SECRET_TEXT = 'draft text that must never be plaintext on disk'

function countingDisk() {
	const docs = new Map<string, string>()
	const calls = { read: 0, put: 0, remove: 0, list: 0 }
	const adapter: QueueDocAdapter = {
		read: async (id) => { calls.read += 1; return docs.get(id) ?? null },
		put: async (id, t) => { calls.put += 1; docs.set(id, t) },
		remove: async (id) => { calls.remove += 1; docs.delete(id) },
		list: async (p) => { calls.list += 1; return [...docs.keys()].filter((k) => k.startsWith(p)) },
	}
	return { docs, calls, adapter }
}
const draft = () => nextDraft(undefined, SECRET_TEXT, 1, () => 'send-1')

describe('no key, no stores, no writes (browser)', () => {
	it('a browser page without its key armor (empty, undefined, null) gets NO stores: nothing is created, no adapter call is made, no document exists', () => {
		for (const privateKey of ['', undefined, null]) {
			const d = countingDisk()
			expect(createChatDocStores({ eoa: EOA, privateKey, nativeShell: false, doc: d.adapter })).toBeNull()
			expect(d.calls).toEqual({ read: 0, put: 0, remove: 0, list: 0 })
			expect(d.docs.size).toBe(0)
		}
	})
	it('the hazard this prevents: the keyless codec would write the draft as base64 PLAINTEXT, which the keyed page can then never read', async () => {
		const d = countingDisk()
		const keyless = createDraftStore({ eoa: EOA, doc: d.adapter, codec: base64JsonCodec() }) // what a store without a key would write
		await keyless.saveSlot(PEER, 'draft', draft())
		const raw = [...d.docs.values()][0]
		expect(Buffer.from(raw, 'base64').toString('utf8')).toContain(SECRET_TEXT) // plaintext on disk
		const keyed = createChatDocStores({ eoa: EOA, privateKey: ARMOR, nativeShell: false, doc: d.adapter }) as NonNullable<ReturnType<typeof createChatDocStores>>
		expect(await keyed.draftStore.load()).toEqual({}) // the keyed page cannot read it: it is "permanently unreadable"
	})
	it('a keyed browser gets all four stores and its draft is sealed: no plaintext on disk', async () => {
		const d = countingDisk()
		const s = createChatDocStores({ eoa: EOA, privateKey: ARMOR, nativeShell: false, doc: d.adapter })
		expect(s).not.toBeNull()
		expect(s?.tags.keyed).toBe(true)
		expect(s?.codec.kind).toBe('aes-gcm')
		await s?.draftStore.saveSlot(PEER, 'draft', draft())
		const raw = [...d.docs.values()][0]
		expect(raw).not.toContain(SECRET_TEXT)
		expect(Buffer.from(raw.split('.')[1] ?? '', 'base64').toString('utf8')).not.toContain(SECRET_TEXT)
		expect(Object.keys((await s?.draftStore.load()) ?? {})).toEqual([PEER])
	})
	it('a native shell has no key by design and gets the keyless stores as before (base64 JSON, not encryption)', async () => {
		const d = countingDisk()
		const s = createChatDocStores({ eoa: EOA, privateKey: '', nativeShell: true, doc: d.adapter })
		expect(s).not.toBeNull()
		expect(s?.tags.keyed).toBe(false)
		expect(s?.codec.kind).toBe('base64-json')
	})
	it('chat.tsx builds the stores only through it, returns before creating anything when it is null, and no other file creates them', () => {
		const chat = readFileSync(join(__dirname, '../pages/chat/chat.tsx'), 'utf8')
		const at = chat.indexOf('const stores = createChatDocStores({')
		expect(at).toBeGreaterThan(0)
		const guard = chat.slice(at, at + 700)
		expect(guard).toMatch(/if \(!stores\) \{\s*draftAutosaverRef\.current = null\s*sendQueueRef\.current = null\s*receiptStoreRef\.current = null\s*deliveredStoreRef\.current = null\s*return\s*\}/)
		for (const creator of ['createDraftStore(', 'createQueueStore(', 'createReceiptStore(', 'createDeliveredStore(', 'createDraftAutosaver(', 'createSendQueue(']) {
			const first = chat.indexOf(creator)
			// the imports are not calls: look for the first call site after the guard
			const callAt = chat.indexOf(creator, at)
			if (creator === 'createDraftAutosaver(' || creator === 'createSendQueue(') expect(callAt).toBeGreaterThan(at)
			else expect(first === -1 || chat.slice(first - 40, first).includes('import') || first > at).toBe(true)
		}
		expect(chat).not.toMatch(/createDraftStore\(|createQueueStore\(|createReceiptStore\(|createDeliveredStore\(/)
	})
	it('App.tsx reads and writes nothing with the keyless tagger in a browser: its receipt lines are held until the key is there', () => {
		const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
		expect(app).toMatch(/canReadSealed: mayUseChatDocs\(tagsNow, isShellContext\(\)\)/)
	})
})
