/**
 * @jest-environment node
 */
// the draft document store, the codecs and the autosaver (chatDraftStore.ts).
import { aesGcmCodec, base64JsonCodec, createDraftAutosaver, createDraftStore, draftDocId, type DraftDocAdapter } from './chatDraftStore'
import type { DraftRecord } from './chatDraftState'
import { beginSend } from './sendFlow'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

function memoryDoc(opts: { failPut?: () => boolean } = {}) {
	const docs = new Map<string, string>()
	const log: string[] = []
	const adapter: DraftDocAdapter = {
		read: async (id) => (docs.has(id) ? (docs.get(id) as string) : null),
		put: async (id, text) => {
			if (opts.failPut?.()) throw new Error('persist_gate_closed')
			docs.set(id, text)
			log.push(`put:${id}`)
		},
		remove: async (id) => {
			docs.delete(id)
			log.push(`remove:${id}`)
		},
	}
	return { docs, log, adapter }
}

const key = new Uint8Array(32).map((_, i) => i + 1)
const PEER = '0xabc0000000000000000000000000000000000001'
const EOA = '0xDEF0000000000000000000000000000000000002'

describe('doc id', () => {
	it('is chat-draft-v1:<eoa lower case>, never the account record id', () => {
		expect(draftDocId(EOA)).toBe(`chat-draft-v1:${EOA.toLowerCase()}`)
		expect(draftDocId(EOA)).not.toBe('init')
	})
})

describe('codecs', () => {
	it('AES-GCM round trips, uses a fresh IV, and the stored text does not contain the plain text', async () => {
		const c = aesGcmCodec(key)
		const plain = JSON.stringify({ text: 'a secret sentence' })
		const a = await c.encode(plain)
		const b = await c.encode(plain)
		expect(a).not.toBe(b)
		expect(a).not.toContain('secret')
		expect(Buffer.from(a.split('.')[1], 'base64').toString('utf8')).not.toContain('secret')
		expect(await c.decode(a)).toBe(plain)
		expect(c.kind).toBe('aes-gcm')
	})

	it('AES-GCM with another key, or damaged text, reads as unreadable (null), not as another text', async () => {
		const a = await aesGcmCodec(key).encode('hello')
		const other = aesGcmCodec(new Uint8Array(32).fill(9))
		expect(await other.decode(a)).toBeNull()
		expect(await aesGcmCodec(key).decode(a.slice(0, -4) + 'AAAA')).toBeNull()
		expect(await aesGcmCodec(key).decode('nodot')).toBeNull()
	})

	it('the shell codec is base64 JSON and says so: it is NOT encryption', async () => {
		const c = base64JsonCodec()
		const stored = await c.encode('hello shell')
		expect(c.kind).toBe('base64-json')
		expect(Buffer.from(stored, 'base64').toString('utf8')).toBe('hello shell')
		expect(await c.decode(stored)).toBe('hello shell')
		expect(await c.decode('%%%')).toBeNull()
	})

	it('the sources never call the shell codec encrypted storage', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs') as typeof import('fs')
		for (const f of ['chatDraftStore.ts', 'sendFlow.ts', 'chatDraftState.ts']) {
			const src = fs.readFileSync(`${__dirname}/${f}`, 'utf8')
			expect(src).not.toMatch(/encrypted storage/i)
		}
		const chat = fs.readFileSync(`${__dirname}/../pages/chat/chat.tsx`, 'utf8')
		expect(chat).not.toMatch(/encrypted storage/i)
		expect(chat).toMatch(/base64 JSON, NOT encryption/)
	})
})

describe('createDraftStore', () => {
	it('writes one document for the account, with every conversation in it; the content is the codec output', async () => {
		const m = memoryDoc()
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: aesGcmCodec(key) })
		const rec = { v: 1, sendId: 's1', text: 'top secret text', createdAt: 1, updatedAt: 1, phase: 'draft' as const }
		await store.saveSlot(PEER, 'draft', rec)
		await store.saveSlot('0xother', 'draft', { ...rec, sendId: 's2' })
		expect([...m.docs.keys()]).toEqual([draftDocId(EOA)])
		expect(m.docs.get(draftDocId(EOA))).not.toContain('top secret')
		const book = await store.load()
		expect(book[PEER].draft?.text).toBe('top secret text')
		expect(Object.keys(book).sort()).toEqual([PEER, '0xother'].sort())
	})

	it('an older version never replaces a newer one', async () => {
		const m = memoryDoc()
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: base64JsonCodec() })
		const base = { sendId: 's1', createdAt: 1, updatedAt: 1, phase: 'draft' as const }
		await store.saveSlot(PEER, 'draft', { ...base, v: 5, text: 'new' })
		await store.saveSlot(PEER, 'draft', { ...base, v: 3, text: 'old' })
		expect((await store.load())[PEER].draft?.text).toBe('new')
	})

	it('removing the last slot removes the document', async () => {
		const m = memoryDoc()
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: base64JsonCodec() })
		await store.saveSlot(PEER, 'draft', { v: 2, sendId: 's1', text: 't', createdAt: 1, updatedAt: 1, phase: 'draft' })
		await store.removeSlot(PEER, 'draft', 's1')
		expect(m.docs.size).toBe(0)
		expect(await store.load()).toEqual({})
	})

	it('removing a draft slot of another sendId does not remove this one; the book holds drafts only (one per contact), never a sent message', async () => {
		const m = memoryDoc()
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: base64JsonCodec() })
		await store.saveSlot(PEER, 'draft', { v: 2, sendId: 's1', text: 't', createdAt: 1, updatedAt: 1, phase: 'draft' })
		await store.removeSlot(PEER, 'draft', 'other')
		expect((await store.load())[PEER].draft?.sendId).toBe('s1')
		expect(Object.keys((await store.load())[PEER])).toEqual(['draft'])
	})

	it('a write that is refused rejects (it is never turned into success)', async () => {
		const m = memoryDoc({ failPut: () => true })
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: base64JsonCodec() })
		await expect(store.saveSlot(PEER, 'draft', { v: 1, sendId: 's', text: 't', createdAt: 1, updatedAt: 1, phase: 'draft' })).rejects.toThrow('persist_gate_closed')
	})

	it('a document that cannot be read (wrong key) loads as empty, it does not throw and does not invent a draft', async () => {
		const m = memoryDoc()
		await createDraftStore({ eoa: EOA, doc: m.adapter, codec: aesGcmCodec(key) }).saveSlot(PEER, 'draft', { v: 1, sendId: 's', text: 't', createdAt: 1, updatedAt: 1, phase: 'draft' })
		expect(await createDraftStore({ eoa: EOA, doc: m.adapter, codec: aesGcmCodec(new Uint8Array(32).fill(7)) }).load()).toEqual({})
	})

	it('does not use localStorage or sessionStorage', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs') as typeof import('fs')
		for (const f of ['chatDraftStore.ts', 'sendFlow.ts', 'chatDraftState.ts']) {
			const code = fs.readFileSync(`${__dirname}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
			expect(code).not.toMatch(/localStorage|sessionStorage/)
		}
	})
})

describe('createDraftAutosaver', () => {
	function rig(opts: { failPut?: () => boolean; failEnqueue?: () => boolean } = {}) {
		const m = memoryDoc(opts)
		const store = createDraftStore({ eoa: EOA, doc: m.adapter, codec: base64JsonCodec() })
		const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
		let t = 1000
		let ids = 0
		const events: string[] = []
		const enqueued: DraftRecord[] = []
		const auto = createDraftAutosaver({
			store,
			peer: PEER,
			enqueue: async (rec) => {
				if (opts.failEnqueue?.()) return { ok: false, error: new Error('persist_failed') }
				enqueued.push(rec)
				return { ok: true }
			},
			makeSendId: () => `id-${++ids}`,
			now: () => (t += 10),
			setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h },
			clearTimer: (h) => { (h as { live: boolean }).live = false },
			onDirty: () => events.push('dirty'),
			onSaved: () => events.push('saved'),
		})
		const fire = async () => { for (const h of timers) if (h.live) { h.live = false; h.fn() } ; await new Promise((r) => setImmediate(r)) }
		return { m, store, auto, timers, fire, events, enqueued }
	}
	const settle = () => new Promise((res) => setImmediate(res))

	it('the first keystroke of a new draft is written at once (leading edge); later keystrokes are throttled; after a send the next draft is leading again', async () => {
		const r = rig()
		r.auto.onInput('h')
		await settle()
		expect(r.m.log).toHaveLength(1) // written before any timer fired
		r.auto.onInput('he')
		r.auto.onInput('hel')
		await settle()
		expect(r.m.log).toHaveLength(1) // throttled
		await r.fire()
		expect(r.m.log).toHaveLength(2)
		await r.auto.commitPending()
		await settle()
		const before = r.m.log.length
		r.auto.onInput('next message')
		await settle()
		expect(r.m.log.length).toBeGreaterThan(before) // leading again
	})

	it('the trailing throttle is 200 ms by default (the window of typed text with no stored copy is the throttle plus one write)', async () => {
		const r = rig()
		r.auto.onInput('a')
		r.auto.onInput('ab')
		expect(r.timers.filter((h) => h.live).map((h) => h.ms)).toEqual([200])
	})

	it('typing is coalesced: many inputs, one throttle timer, one trailing write of the newest version', async () => {
		const r = rig()
		for (const s of ['h', 'he', 'hel', 'hell', 'hello']) r.auto.onInput(s)
		expect(r.timers.filter((h) => h.live)).toHaveLength(1)
		await r.fire()
		expect(r.m.log.length).toBeLessThanOrEqual(2)
		expect((await r.store.load())[PEER].draft?.text).toBe('hello')
		expect(r.events[0]).toBe('dirty')
		expect(r.events[r.events.length - 1]).toBe('saved')
	})

	it('flushNow cancels the timer and writes the latest text at once', async () => {
		const r = rig()
		r.auto.onInput('abc')
		const res = await r.auto.flushNow()
		expect(res?.ok).toBe(true)
		expect(r.timers.every((h) => !h.live)).toBe(true)
		expect((await r.store.load())[PEER].draft?.text).toBe('abc')
	})

	it('empty text with nothing typed is not a draft; an empty box after a send is not a new draft', async () => {
		const r = rig()
		r.auto.onInput('')
		expect(r.timers).toHaveLength(0)
		r.auto.onInput('x')
		const c = await r.auto.commitPending()
		expect(c.ok).toBe(true)
		r.auto.onInput('')
		expect(r.auto.latest()?.phase).toBe('pending')
	})

	it('clearing the box after typing is saved as an empty draft (the stored draft does not come back)', async () => {
		const r = rig()
		r.auto.onInput('abc')
		await r.auto.flushNow()
		r.auto.onInput('')
		await r.auto.flushNow()
		const book = await r.store.load()
		expect(book[PEER]?.draft?.text ?? '').toBe('')
	})

	it('the click: the message goes to the queue WITHOUT any timer, with the sendId made at the first keystroke; the draft slot of this message is released', async () => {
		const r = rig()
		r.auto.onInput('hello')
		await settle()
		const first = r.auto.latest()
		r.timers.forEach((h) => { h.live = false }) // a throttle timer that never fires: the send path must not depend on it
		const c = await r.auto.commitPending()
		expect(c.ok).toBe(true)
		expect(r.enqueued).toHaveLength(1)
		expect(r.enqueued[0].sendId).toBe(first?.sendId)
		expect(r.enqueued[0].text).toBe('hello')
		await settle()
		expect((await r.store.load())[PEER]).toBeUndefined() // the draft slot is gone; nothing of the clicked message is kept in the draft document
	})

	it('a failed queue write: not ok, beginSend does not clear the input, and the draft stays dirty (held) unless its latest version is on disk', async () => {
		let fail = false
		const r = rig({ failEnqueue: () => fail })
		r.auto.onInput('keep me')
		await r.auto.flushNow()
		fail = true
		let cleared = false
		let notSaved = false
		const out = await beginSend({ autosaver: r.auto, currentText: 'keep me', clearInput: () => { cleared = true }, onNotSaved: () => { notSaved = true } })
		expect(out.ok).toBe(false)
		expect(cleared).toBe(false)
		expect(notSaved).toBe(true)
		expect(r.auto.latest()?.phase).toBe('draft')
		expect(r.enqueued).toHaveLength(0)
		expect((await r.store.load())[PEER].draft?.text).toBe('keep me') // the last committed draft is still there
	})

	it('after a failed queue write the same click can be repeated and then succeeds with the same sendId', async () => {
		let fail = true
		const r = rig({ failEnqueue: () => fail })
		r.auto.onInput('again')
		const id = r.auto.latest()?.sendId
		expect((await r.auto.commitPending()).ok).toBe(false)
		fail = false
		const second = await r.auto.commitPending()
		expect(second.ok && second.rec.sendId).toBe(id)
	})

	it('the dirty hold: dirty after the first keystroke, saved only once written; the click holds from its start to its landing', async () => {
		const r = rig()
		r.auto.onInput('a')
		expect(r.events[0]).toBe('dirty')
		await r.auto.flushNow()
		expect(r.events[r.events.length - 1]).toBe('saved')
		expect(r.events.lastIndexOf('dirty')).toBeLessThan(r.events.indexOf('saved'))
		r.events.length = 0
		await r.auto.commitPending()
		expect(r.events[0]).toBe('dirty') // held from the start of the click write
		expect(r.events[r.events.length - 1]).toBe('saved')
	})

	it('versions go on after a seed from a reload and never go back', async () => {
		const r = rig()
		r.auto.seed({ v: 9, sendId: 'old', text: 'was', createdAt: 1, updatedAt: 1, phase: 'draft' })
		r.auto.onInput('was more')
		expect(r.auto.latest()?.v).toBe(10)
		expect(r.auto.latest()?.sendId).toBe('old')
	})

	it('two clicks in a row are two queue items with two sendIds (the second text is a new message)', async () => {
		const r = rig()
		r.auto.onInput('one')
		await r.auto.commitPending()
		r.auto.onInput('two')
		await r.auto.commitPending()
		expect(r.enqueued.map((x) => x.text)).toEqual(['one', 'two'])
		expect(new Set(r.enqueued.map((x) => x.sendId)).size).toBe(2)
	})
})
