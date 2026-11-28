/**
 * @jest-environment node
 */
// the page side of the native-shell send, against IFACE-native-send-v1, with a fake native layer that
// follows the interface: it stores one copy per inner-armor digest (the mailbox), answers with the classified entry answer, and never caches a failure. The seven vectors of the interface (section 5) and the old-shell rule.
import { readFileSync } from 'fs'
import { join } from 'path'
import { armorDigest, type SendArmorContext, type SendReceipt } from './sendAnswer'
import { decideReceipt } from './sendReceiptPolicy'
import { NATIVE_SEND_REUSE_CAPABILITY, classifyNativeSendAnswer, nativeSendReuseOf, parseNativeSendAnswer, sendViaNative, wireSendId, type NativeEntryAnswer, type NativeSendAnswer, type NativeSendClient } from './nativeSendProtocol'
import { createQueueStore, createSendQueue, type QueueDocAdapter, type QueueItem } from './sendQueue'
import { base64JsonCodec } from './chatDraftStore'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	;(globalThis as unknown as { crypto: unknown }).crypto = require('crypto').webcrypto
}

const SEND_ID = '1767225600000-aaaa1111'
const PAYLOAD = JSON.stringify({ sendId: SEND_ID, from: 'me', text: 'hello', createdAt: 1 })
const armorText = (tag: string): string => `-----BEGIN PGP MESSAGE-----\n${tag}\n-----END PGP MESSAGE-----`
const TO = {} as never

type Step = { entry: NativeEntryAnswer['kind'] | 'error'; posted?: boolean; error?: string }

/** The fake native layer: one mailbox (digest -> copies kept: the mailbox keeps identical armor once), a script of entry answers, counters. */
function fakeNative(script: Step[] = []) {
	const mailbox = new Map<string, number>()
	const calls = { prepare: 0, send: 0, legacy: 0 }
	const sendArgs: Array<{ sendId: string; armor: string; armorDigest: string }> = []
	let prepareTag = 0
	let wrongDigest = false
	const client: NativeSendClient = {
		sendMessage: async () => { calls.legacy += 1; return { sendId: 'native-random' } },
		sendPrepare: async (_to, _payload, sendId) => {
			calls.prepare += 1
			prepareTag += 1
			const armor = armorText(`${sendId}#${prepareTag}`)
			return { sendId, armor, armorDigest: wrongDigest ? '0xdeadbeef' : armorDigest(armor) }
		},
		sendArmored: async (_to, _payload, input) => {
			calls.send += 1
			sendArgs.push({ sendId: input.sendId, armor: input.armor, armorDigest: input.armorDigest })
			const step = script.shift() ?? { entry: 'bound', posted: true }
			if (step.entry === 'error') throw new Error(step.error ?? 'native_error')
			if (armorDigest(input.armor).toLowerCase() !== input.armorDigest.toLowerCase()) throw new Error('armor_digest_mismatch')
			let entryAnswer: NativeEntryAnswer
			const posted = step.posted ?? (step.entry === 'bound' || step.entry === 'empty_200')
			let duplicate = false
			if (posted) {
				duplicate = mailbox.has(input.armorDigest)
				mailbox.set(input.armorDigest, 1) // one copy per inner digest, however many posts
			}
			if (step.entry === 'bound') entryAnswer = { kind: 'bound', stored: !duplicate, duplicate, h: input.armorDigest, hMatches: true }
			else entryAnswer = { kind: step.entry } as NativeEntryAnswer
			return { sendId: input.sendId, armorDigest: input.armorDigest, sent: step.entry === 'bound' || step.entry === 'empty_200', entryAnswer, tried: 1 } as NativeSendAnswer
		},
	}
	return { client, mailbox, calls, sendArgs, setWrongDigest: (v: boolean) => { wrongDigest = v } }
}

/** The queue's armor store for one sendId: what a queue document holds (`armor`) and the way a new armor is persisted. */
function armorStore(initial?: string) {
	const ctx: SendArmorContext & { recorded: string[] } = {
		armor: initial,
		recorded: [],
		record: async (armor) => { ctx.armor = armor; ctx.recorded.push(armor) },
	}
	return ctx
}

const send = (n: ReturnType<typeof fakeNative>, ctx: SendArmorContext, over: Partial<Parameters<typeof sendViaNative>[0]> = {}) => {
	const receipts: SendReceipt[] = []
	const stages: string[] = []
	const p = sendViaNative({ client: n.client, reuse: true, to: TO, payload: PAYLOAD, armor: ctx, onReceipt: (r) => receipts.push(r), stage: (c) => stages.push(c), ...over })
	return p.then((r) => ({ ...r, receipts, stages }))
}

describe('vector 1: the first send: prepare, store the armor, then send it', () => {
	it('the armor is stored BEFORE the send leaves, the send carries that armor and its digest, the answer is bound, and exactly one copy is in the mailbox', async () => {
		const n = fakeNative()
		const ctx = armorStore()
		const order: string[] = []
		const base = n.client.sendArmored as NonNullable<NativeSendClient['sendArmored']>
		n.client.sendArmored = async (...a) => { order.push(`send(stored=${ctx.recorded.length})`); return base(...a) }
		const r = await send(n, ctx)
		expect(r).toMatchObject({ ok: true })
		expect(n.calls).toMatchObject({ prepare: 1, send: 1, legacy: 0 })
		expect(order).toEqual(['send(stored=1)']) // the armor was recorded before the send was made
		expect(ctx.armor).toBe(n.sendArgs[0].armor)
		expect(r.receipts).toEqual([{ kind: 'bound', digest: armorDigest(n.sendArgs[0].armor) }])
		expect(n.mailbox.size).toBe(1)
	})
	it('a prepare that fails, or whose armor cannot be stored, sends NOTHING', async () => {
		const n = fakeNative()
		n.client.sendPrepare = async () => { throw new Error('encrypt_failed') }
		const a = await send(n, armorStore())
		expect(a).toMatchObject({ ok: false, code: 'native_prepare_failed' })
		expect(n.calls.send).toBe(0)
		const m = fakeNative()
		const ctx = armorStore()
		ctx.record = async () => { throw new Error('disk') }
		const b = await send(m, ctx)
		expect(b).toMatchObject({ ok: false, code: 'armor_not_stored' })
		expect(m.calls.send).toBe(0)
	})
})

describe('vector 2: the answer is lost, the page is killed, the same sendId is sent again from the stored armor', () => {
	it('the first attempt gets a network error after the post landed; after a restart (a new client, the armor from the queue document) the same armor goes again: no prepare, one copy in the mailbox, bound/duplicate', async () => {
		const n1 = fakeNative([{ entry: 'network_error', posted: true }])
		const ctx = armorStore()
		const first = await send(n1, ctx)
		expect(first).toMatchObject({ ok: false, code: 'native_network_error' })
		const storedArmor = ctx.armor as string
		expect(storedArmor).toBeTruthy()
		// kill and restart: a new native client, the same mailbox, the armor read back from the queue document
		const n2 = fakeNative()
		n2.mailbox.set(armorDigest(storedArmor), 1)
		const again = await send(n2, armorStore(storedArmor))
		expect(again.ok).toBe(true)
		expect(n2.calls).toMatchObject({ prepare: 0, send: 1 }) // no second encryption
		expect(n2.sendArgs[0].armor).toBe(storedArmor)
		expect(again.receipts[0].kind).toBe('bound')
		expect(n2.mailbox.size).toBe(1) // the recipient has exactly one
	})
})

describe('vector 3: an empty 200 is accepted but never a confirmation', () => {
	it('ok true, receipt legacy_empty, and the queue decision is awaiting (not released)', async () => {
		const n = fakeNative([{ entry: 'empty_200' }])
		const r = await send(n, armorStore())
		expect(r.ok).toBe(true)
		expect(r.receipts[0].kind).toBe('legacy_empty')
		expect(decideReceipt(r.receipts[0])).toBe('awaiting')
	})
})

describe('vector 4 and 7: store_failed, a timeout and a network error fail the attempt; the next send re-posts the SAME armor (a failure is never replayed as done)', () => {
	for (const kind of ['store_failed', 'timeout', 'network_error', 'rejected', 'unreadable'] as const) {
		it(`${kind}: ok false, no receipt; the retry sends the identical armor and goes through`, async () => {
			const n = fakeNative([{ entry: kind, posted: false }])
			const ctx = armorStore()
			const a = await send(n, ctx)
			expect(a).toMatchObject({ ok: false, code: `native_${kind}` })
			expect(a.receipts).toEqual([])
			const b = await send(n, ctx)
			expect(b.ok).toBe(true)
			expect(n.calls).toMatchObject({ prepare: 1, send: 2 })
			expect(n.sendArgs[1].armor).toBe(n.sendArgs[0].armor)
			expect(n.mailbox.size).toBe(1)
		})
	}
})

describe('vector 5: the digest', () => {
	it('a prepare whose digest is not the digest of its armor is refused and nothing is stored or sent', async () => {
		const n = fakeNative()
		n.setWrongDigest(true)
		const ctx = armorStore()
		const r = await send(n, ctx)
		expect(r).toMatchObject({ ok: false, code: 'native_digest_mismatch' })
		expect(ctx.recorded).toEqual([])
		expect(n.calls.send).toBe(0)
	})
	it('a prepare that is not a PGP message armor is refused', async () => {
		const n = fakeNative()
		n.client.sendPrepare = async (_t, _p, sendId) => ({ sendId, armor: 'not an armor', armorDigest: '0x00' })
		expect(await send(n, armorStore())).toMatchObject({ ok: false, code: 'native_armor_invalid' })
	})
	it('the native layer refusing the STORED armor (armor_digest_mismatch / armor_invalid): one re-prepare, the new armor is stored and sent; a second refusal is a plain failure', async () => {
		const n = fakeNative([{ entry: 'error', error: 'armor_digest_mismatch' }])
		const ctx = armorStore(armorText('stale'))
		const r = await send(n, ctx)
		expect(r.ok).toBe(true)
		expect(n.calls).toMatchObject({ prepare: 1, send: 2 })
		expect(ctx.armor).toBe(n.sendArgs[1].armor)
		expect(ctx.armor).not.toBe(armorText('stale'))
		const m = fakeNative([{ entry: 'error', error: 'armor_invalid' }, { entry: 'error', error: 'armor_invalid' }])
		const again = await send(m, armorStore(armorText('stale')))
		expect(again.ok).toBe(false)
		expect(m.calls.prepare).toBe(1)
	})
	it('the recipient key changed (the stored armor no longer matches): the page prepares anew and stores the new armor', async () => {
		const n = fakeNative()
		const ctx = armorStore(armorText('old-key'))
		const r = await send(n, ctx, { matchesRecipient: async () => false })
		expect(r.ok).toBe(true)
		expect(n.calls.prepare).toBe(1)
		expect(ctx.armor).toBe(n.sendArgs[0].armor)
	})
})

describe('vector 6: one attempt per sendId at a time (the queue claim), and different sendIds stay independent', () => {
	const memoryDisk = (): QueueDocAdapter => {
		const docs = new Map<string, string>()
		return { read: async (id) => docs.get(id) ?? null, put: async (id, t) => { docs.set(id, t) }, remove: async (id) => { docs.delete(id) }, list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)) }
	}
	it('two triggers for the same sendId at once make ONE send command', async () => {
		const n = fakeNative()
		const gate: { release: () => void } = { release: () => undefined }
		const base = n.client.sendArmored as NonNullable<NativeSendClient['sendArmored']>
		const held = new Promise<void>((r) => { gate.release = r })
		n.client.sendArmored = async (...a) => { await held; return base(...a) }
		const item: QueueItem = { v: 1, sendId: SEND_ID, peer: '0xcccc000000000000000000000000000000000003', text: 'hello', createdAt: 1, queuedAt: 1 }
		const q = createSendQueue({
			store: createQueueStore({ eoa: '0xaaaa000000000000000000000000000000000001', doc: memoryDisk(), codec: base64JsonCodec() }),
			peer: item.peer, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0,
		})
		await q.enqueue(item)
		const ctx = armorStore()
		const attempt = async () => ((await send(n, ctx)).ok ? ({ kind: 'awaiting', persisted: true } as const) : ({ kind: 'failed' } as const))
		const a = q.run(SEND_ID, attempt)
		const b = q.run(SEND_ID, attempt)
		for (let i = 0; i < 20; i++) await Promise.resolve()
		gate.release()
		const results = await Promise.all([a, b])
		expect(results.filter((r) => r === 'skipped').length).toBe(1)
		expect(n.calls.send).toBe(1)
		q.dispose()
	})
	it('two different sendIds in flight together: each answer is bound to its own (sendId, digest); a swapped answer is dropped', async () => {
		const n = fakeNative()
		const p2 = JSON.stringify({ sendId: 'other-send-id', from: 'me', text: 'second', createdAt: 2 })
		const [a, b] = await Promise.all([send(n, armorStore()), send(n, armorStore(), { payload: p2 })])
		expect(a.ok && b.ok).toBe(true)
		expect(n.mailbox.size).toBe(2)
		const swapped = classifyNativeSendAnswer({ sendId: 'other-send-id', armorDigest: '0x01', sent: true, entryAnswer: { kind: 'empty_200' } }, { sendId: SEND_ID, digest: '0x01' })
		expect(swapped).toEqual({ ok: false, code: 'native_answer_mismatch' })
	})
})

describe('the verdict on an answer (IFACE 3.2)', () => {
	const D = '0xabc123'
	const ok = (entryAnswer: NativeEntryAnswer | undefined, sent = true): NativeSendAnswer => ({ sendId: SEND_ID, armorDigest: D, sent, ...(entryAnswer ? { entryAnswer } : {}) })
	const verdict = (a: NativeSendAnswer | null) => classifyNativeSendAnswer(a, { sendId: SEND_ID, digest: D })
	it('bound with h equal to the digest and stored or duplicate is the only positive proof', () => {
		expect(verdict(ok({ kind: 'bound', stored: true, h: D, hMatches: true }))).toEqual({ ok: true, receipt: { kind: 'bound', digest: D } })
		expect(verdict(ok({ kind: 'bound', duplicate: true, h: D.toUpperCase().replace('0X', '0x') }))).toEqual({ ok: true, receipt: { kind: 'bound', digest: D } })
	})
	it('bound with another h, no stored/duplicate, or hMatches false is NOT a proof (a failed attempt)', () => {
		for (const e of [{ kind: 'bound', stored: true, h: '0xother' }, { kind: 'bound', h: D }, { kind: 'bound', stored: true, h: D, hMatches: false }] as NativeEntryAnswer[]) expect(verdict(ok(e))).toEqual({ ok: false, code: 'native_receipt_mismatch' })
	})
	it('empty 200 is unconfirmed; every other kind is a failure', () => {
		expect(verdict(ok({ kind: 'empty_200' }))).toMatchObject({ ok: true, receipt: { kind: 'legacy_empty' } })
		for (const k of ['store_failed', 'rejected', 'unreadable', 'network_error', 'timeout'] as const) expect(verdict(ok({ kind: k } as NativeEntryAnswer, false))).toEqual({ ok: false, code: `native_${k}` })
	})
	it('an answer for another sendId or another armorDigest is dropped; an unreadable answer is a failure', () => {
		expect(verdict({ ...ok({ kind: 'empty_200' }), sendId: 'other' })).toEqual({ ok: false, code: 'native_answer_mismatch' })
		expect(verdict({ ...ok({ kind: 'empty_200' }), armorDigest: '0x999' })).toEqual({ ok: false, code: 'native_answer_mismatch' })
		expect(verdict(null)).toEqual({ ok: false, code: 'native_answer_unreadable' })
	})
	it('no entryAnswer: the legacy `sent: true` is NOT a confirmation (unconfirmed), `sent: false` is a failure', () => {
		expect(verdict(ok(undefined, true))).toMatchObject({ ok: true, receipt: { kind: 'legacy_empty' } })
		expect(verdict(ok(undefined, false))).toEqual({ ok: false, code: 'native_not_sent' })
	})
	it('parseNativeSendAnswer keeps the interface fields and refuses anything else', () => {
		expect(parseNativeSendAnswer({ sendId: 's', sent: true, armorDigest: '0x1', tried: 2, entryAnswer: { kind: 'bound', stored: true, h: '0x1', hMatches: true, junk: 1 } })).toEqual({ sendId: 's', sent: true, armorDigest: '0x1', tried: 2, entryAnswer: { kind: 'bound', stored: true, h: '0x1', hMatches: true } })
		expect(parseNativeSendAnswer({ sendId: 's', sent: false, entryAnswer: { kind: 'rejected', status: 503 } })).toEqual({ sendId: 's', sent: false, entryAnswer: { kind: 'rejected', status: 503 } })
		for (const bad of [null, undefined, 'x', {}, { sent: true }, { sendId: 's' }, { sendId: '', sent: true }]) expect(parseNativeSendAnswer(bad)).toBeNull()
		expect(parseNativeSendAnswer({ sendId: 's', sent: true, entryAnswer: { kind: 'made_up' } })).toEqual({ sendId: 's', sent: true }) // an unknown kind is dropped, the legacy field is judged
	})
})

describe('the old shell: no capability, no payload sendId, or no queue: the old path, and its sent:true is unconfirmed', () => {
	it('capability off: sendMessage is used, no sendPrepare, no armor; success is reported as legacy_empty (never bound)', async () => {
		const n = fakeNative()
		const r = await send(n, armorStore(), { reuse: false })
		expect(r.ok).toBe(true)
		expect(n.calls).toMatchObject({ legacy: 1, prepare: 0, send: 0 })
		expect(r.receipts).toEqual([{ kind: 'legacy_empty', digest: '' }])
		expect(decideReceipt(r.receipts[0])).toBe('awaiting')
	})
	it('an old shell that fails: ok false and no receipt', async () => {
		const n = fakeNative()
		n.client.sendMessage = async () => { throw new Error('native send: not delivered to any entry') }
		const r = await send(n, armorStore(), { reuse: false })
		expect(r).toMatchObject({ ok: false, code: 'native_error' })
		expect(r.receipts).toEqual([])
	})
	it('a payload without a sendId, or no armor store (no queue item), also takes the old path even when the shell has the capability', async () => {
		const n = fakeNative()
		await send(n, armorStore(), { payload: JSON.stringify({ text: 'call signal' }) })
		await sendViaNative({ client: n.client, reuse: true, to: TO, payload: PAYLOAD })
		expect(n.calls).toMatchObject({ legacy: 2, prepare: 0, send: 0 })
	})
	it('a client without the new methods is the old path too', async () => {
		const n = fakeNative()
		delete n.client.sendPrepare
		const r = await send(n, armorStore())
		expect(r.ok).toBe(true)
		expect(n.calls.legacy).toBe(1)
	})
})

describe('capability and wire helpers', () => {
	it('IFACE v1.2: the sendId of a text wire is the TOP-LEVEL `sendId` field of the payload JSON ({sendId, from, text, createdAt, quote?}); a nested one (the quote has `id`, not sendId) is never looked at', () => {
		expect(wireSendId(JSON.stringify({ sendId: SEND_ID, from: 'me', text: 't', createdAt: 1, quote: { id: 'x', text: 'q', from: 'them' } }))).toBe(SEND_ID)
		expect(wireSendId(JSON.stringify({ from: 'me', text: 't', quote: { sendId: 'nested-1', id: 'x' } }))).toBeNull()
		expect(wireSendId(JSON.stringify({ sendId: SEND_ID, quote: { sendId: 'nested-1' } }))).toBe(SEND_ID)
		expect(wireSendId(JSON.stringify({ sendId: '  ' }))).toBeNull()
		expect(wireSendId(JSON.stringify({ sendId: 5 }))).toBeNull()
	})
	it('send.armorReuse.v1 is read from the RAW hello and only for a negotiated answer', () => {
		expect(NATIVE_SEND_REUSE_CAPABILITY).toBe('send.armorReuse.v1')
		const hello = { protocolVersion: 1, capabilities: ['send.mailboxWrap', 'send.armorReuse.v1'] }
		expect(nativeSendReuseOf(hello, true)).toBe(true)
		expect(nativeSendReuseOf(hello, false)).toBe(false) // legacy / incompatible
		expect(nativeSendReuseOf({ protocolVersion: 1, capabilities: ['send.mailboxWrap'] }, true)).toBe(false)
		for (const bad of [null, undefined, 'x', {}, { capabilities: 'send.armorReuse.v1' }]) expect(nativeSendReuseOf(bad, true)).toBe(false)
	})
	it('wireSendId: the sendId inside the payload, or null', () => {
		expect(wireSendId(PAYLOAD)).toBe(SEND_ID)
		for (const bad of ['', 'not json', '{}', '{"sendId":""}', '{"sendId":5}', '[]', 'null']) expect(wireSendId(bad)).toBeNull()
	})
})

describe('wiring (static): the bridge and chat.ts hand the armor context down; the shell branch no longer returns before it; no value is logged', () => {
	const src = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
	it('chat.ts passes armor, matchesRecipient and onReceipt to the native send', () => {
		const chat = src('chat.ts')
		expect(chat).toMatch(/armor: opts\?\.armor,\s*matchesRecipient: \(armor\) => armorMatchesRecipient\(armor, pgpPublic\),\s*onReceipt: opts\?\.onReceipt,/)
		expect(chat).not.toMatch(/return sendChatViaNativeDaemon\(\s*\{ address: '', userPublicKeyArmored: pgpPublic, routerArmoredPublicKey: recipientRoute \},\s*text,\s*opts\?\.beamioNoPush \? \{ beamioNoPush: true \} : undefined,\s*\)/)
	})
	it('the bridge reads the capability from the raw hello, resets it with the features, and sends through sendViaNative', () => {
		const b = src('chatWorkerBridge.ts')
		expect(b).toMatch(/activeSendReuse = nativeSendReuseOf\(helloAnswer, features\.status === 'negotiated'\)/)
		expect((b.match(/activeSendReuse = false/g) ?? []).length).toBeGreaterThanOrEqual(3)
		expect(b).toMatch(/const result = await sendViaNative\(\{[\s\S]*?reuse: activeSendReuse,[\s\S]*?armor: opts\?\.armor,[\s\S]*?\}\)\s*return result\.ok/)
	})
	it('the transport sends sendPrepare and the armored send with schema 1, through the generation-tagged request', () => {
		const t = src('nativeConetChatTransport.ts')
		expect(t).toMatch(/type: 'sendPrepare', schema: NATIVE_SEND_SCHEMA, to, payload, sendId/)
		expect(t).toMatch(/type: 'send', schema: NATIVE_SEND_SCHEMA, to, payload, sendId: input\.sendId, armor: input\.armor, armorDigest: input\.armorDigest/)
	})
	it('nativeSendProtocol.ts never logs and never stores', () => {
		const code = src('nativeSendProtocol.ts').replace(/\/\*[\s\S]*?\*\//g, '')
		expect(code).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|debugLog|fetch\(/)
	})
})
