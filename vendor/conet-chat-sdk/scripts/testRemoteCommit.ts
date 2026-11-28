/**
 * "the mailbox ACK only after the remote commit" - the REAL HistoryStore.append with the NETWORK stubbed at fetch level (storageFragment and setChatIndexPointer answer per a switchable server model;
 * the registry nonce read answers 0). Real LocalChatStore (in-memory backend), real persistence map, synthetic wallet and rows.
 *
 *  A an inbound append resolves only when the fragment upload, the index upload and the pointer move all succeeded; each failing step (upload, pointer, timeout) REJECTS with remote_commit_failed:<step>
 *  B a failed remote commit keeps the local copy (index record, fragment cache, library row) and a durable pending record; nothing is rolled back or deleted
 *  C the retry (same sendId, anything else may differ) resumes the commit: no second index record, no second library row, no second fragment; the pending list empties
 *  D the mandatory six steps on ONE account and ONE sendId: 1 local copy stored; 2 remote pointer fails; 3 restart; 4 mailbox redelivery; 5 resume succeeds; 6 only then the ACK; one row everywhere
 *  E outbound mirrors and a store without apiBaseUrl do not need the remote (unchanged behaviour)
 *  M  an upload counts only when its content reads back by hash, byte for byte, bypassing caches
 * Run: npx tsx scripts/testRemoteCommit.ts
 */
import { ethers } from 'ethers'
import { HistoryStore } from '../src/worker/history.js'
import { sharedLockFor } from './fixtures/historyHarness.js'
import { aesGcmDecryptString, aesGcmEncryptString, hkdf } from '../src/crypto.js'
import { deriveLocalKeys } from '../src/local/keys.js'
import { LocalChatStore } from '../src/local/store.js'
import { MemoryBackend, MemoryData } from '../src/local/backend.js'
import type { Viewport } from '../src/local/types.js'

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail?: string): void {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` - ${detail}` : ''}`)
}

const wallet = ethers.Wallet.createRandom()
const eoa = wallet.address.toLowerCase()
const peer = '0x' + '22'.repeat(20)
const VP: Viewport = { widthPt: 390, heightPt: 2000, orientation: 'portrait', fontScale: 1, layoutVersion: 1 }
const PENDING_KEY = `beamio.chat.history.remotepending:${eoa}`

type Persist = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; keys?(p: string): Promise<string[]> }
const persistenceOver = (map: Map<string, unknown>): Persist => ({
	get: async (k) => map.get(k),
	set: async (k, v) => void map.set(k, v),
	delete: async (k) => void map.delete(k),
	keys: async (prefix) => [...map.keys()].filter((k) => k >= prefix && k <= `${prefix}￿`),
})
const keysPromise = (async () => deriveLocalKeys(await hkdf(new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff), 'test-rdb-v1', 32), eoa, 'ws'))()

/** the server model behind fetch */
type Net = { storage: 'ok' | 'fail' | 'hang'; pointer: 'ok' | 'fail'; pointerBody: string; events: string[]; storedBodies: string[]; pointerOk: number; pointerFail: number; storageCalls: number; failStorageCall: number; failBody: string; save: boolean; read: 'ok' | 'missing' | 'hang' | 'http500' | 'differs' | 'extra_byte' | 'partial'; saved: Map<string, string>; httpCache: Map<string, string>; reads: Array<{ url: string; cache?: string }> }
const POINTER_OK = '{"success":true,"txHash":"0x01"}'
const net: Net = { storage: 'ok', pointer: 'ok', pointerBody: POINTER_OK, events: [], storedBodies: [], pointerOk: 0, pointerFail: 0, storageCalls: 0, failStorageCall: 0, failBody: '', save: true, read: 'ok', saved: new Map(), httpCache: new Map(), reads: [] }
const resetNet = (): void => { net.storage = 'ok'; net.pointer = 'ok'; net.pointerBody = POINTER_OK; net.events = []; net.storedBodies = []; net.pointerOk = 0; net.pointerFail = 0; net.storageCalls = 0; net.failStorageCall = 0; net.failBody = ''; net.save = true; net.read = 'ok'; net.saved = new Map(); net.httpCache = new Map(); net.reads = [] }
globalThis.fetch = (async (url: string, init?: { body?: string; signal?: AbortSignal; cache?: string }) => {
	const u = String(url)
	if (u.includes('/getFragment?')) {
		const hash = new URL(u).searchParams.get('hash') ?? ''
		net.reads.push({ url: u, cache: init?.cache })
		// the HTTP cache of a client: a request that does not opt out of it can be answered from an earlier copy, whatever the server holds now
		if (init?.cache !== 'no-store' && net.httpCache.has(u)) return new Response(net.httpCache.get(u), { status: 200 })
		if (net.read === 'hang') return await new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted (timeout)'))) })
		if (net.read === 'http500') return new Response(net.saved.get(hash) ?? 'x', { status: 500 }) // even with the right bytes
		const body = net.saved.get(hash)
		if (net.read === 'missing' || body === undefined) return new Response('', { status: 404 })
		if (net.read === 'differs') return new Response(`${body.slice(0, -2)}${body.slice(-2) === 'AA' ? 'BB' : 'AA'}`, { status: 200 })
		if (net.read === 'extra_byte') return new Response(`${body}\n`, { status: 200 })
		if (net.read === 'partial') return new Response(body.slice(0, 10), { status: 200 })
		return new Response(body, { status: 200 })
	}
	if (u.endsWith('/storageFragment')) {
		net.storageCalls += 1
		if (net.storage === 'hang') {
			return await new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted (timeout)'))) })
		}
		if (net.storage === 'fail' || net.failStorageCall === net.storageCalls || (net.failBody && String((JSON.parse(String(init?.body)) as { image: string }).image) === net.failBody)) return new Response('x', { status: 502 })
		const image = String((JSON.parse(String(init?.body)) as { image: string }).image)
		net.storedBodies.push(image)
		if (net.save) net.saved.set(ethers.keccak256(ethers.toUtf8Bytes(image)), image)
		net.events.push('storage_ok')
		return new Response('{}', { status: 200 })
	}
	if (u.endsWith('/setChatIndexPointer')) {
		if (net.pointer === 'fail') { net.pointerFail += 1; net.events.push('pointer_fail'); return new Response('x', { status: 500 }) }
		// a 2xx answer is a success only when its body says so
		if (net.pointerBody !== POINTER_OK) { net.pointerFail += 1; net.events.push('pointer_fail'); return new Response(net.pointerBody, { status: 200 }) }
		if (chain.on) {
			// the registry rule: seq must not be below the stored one
			const sent = JSON.parse(String(init?.body)) as { indexHash: string; seq: string }
			if (BigInt(sent.seq) < BigInt(chain.seq)) { net.pointerFail += 1; return new Response('{"success":false,"error":"stale seq"}', { status: 200 }) }
			chain.hash = sent.indexHash
			chain.seq = Number(sent.seq)
		}
		net.pointerOk += 1
		net.events.push('pointer_ok')
		return new Response(net.pointerBody, { status: 200 })
	}
	throw new Error(`unexpected fetch ${u}`)
}) as never

let headSyncs = 0
/** the shared head pointer of the account (only for the scenarios that run the REAL head sync) */
const chain = { on: false, hash: '', seq: 0, readFails: false }
/** one worker process over the shared durable stores (persistence map = the worker's IndexedDB, data = the library database) */
async function process_(map: Map<string, unknown>, data: MemoryData, opts: { apiBaseUrl?: string; timeoutMs?: number; realHead?: boolean } = {}) {
	const h = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined } as never,
		{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'apiBaseUrl' in opts ? opts.apiBaseUrl : 'https://api.test', persistence: persistenceOver(map) as never, accountLock: sharedLockFor(map) },
	)
	await h.init()
	const lib = new LocalChatStore(async () => new MemoryBackend(data))
	const k = await keysPromise
	await lib.openWithKeys({ kId: k.kId.slice(), kIdx: k.kIdx.slice(), dek: k.dek.slice() })
	await lib.setMigrationState('switched')
	const priv = h as unknown as Record<string, unknown> & { manifest: { records: Array<{ sendId?: string; cid: string }> } | null }
	priv.localStore = lib
	priv.localReady = Promise.resolve(lib)
	priv.plainPurgeScheduled = true
	priv.coldReconcileScheduled = true
	// the chain is the other thing stubbed: the head is not read, the registry nonce answers 0
	if (opts.realHead) priv.readOnchainPointer = async () => { if (chain.readFails) throw new Error('rpc read failed (synthetic)'); return chain.hash ? { indexHash: chain.hash, ts: 1n, seq: BigInt(chain.seq) } : null }
	else priv.syncFromHeadUnlocked = async () => { headSyncs += 1; return false }
	priv.readPublishSnapshot = async () => ({ head: opts.realHead ? chain.hash || null : (priv as unknown as { baseHead: string | null }).baseHead, nonce: 0n })
	;(priv.applyMigrationState as (m: string) => void).call(h, 'switched')
	if (opts.timeoutMs) priv.remoteStepTimeoutMs = opts.timeoutMs
	return { h, lib, priv }
}

const entryOf = (sendId: string, ts: number, dir: 'in' | 'out' = 'in') => ({ peer, dir, ts, sendId, body: JSON.stringify({ sendId, text: `synthetic-${sendId}` }) })
const rowsFor = async (lib: LocalChatStore, sendId: string): Promise<number> => {
	const page = await lib.openConversation(peer, VP)
	return page.items.filter((i) => (i.body ?? '').includes(`"sendId":"${sendId}"`)).length
}
const pendingOf = (map: Map<string, unknown>): Array<{ cid: string; sendId?: string }> => {
	const raw = map.get(PENDING_KEY)
	const legacy = typeof raw === 'string' ? JSON.parse(raw) : raw
	const records = [...map].filter(([k]) => k.startsWith(`beamio.chat.history.pendingrec:${eoa}:`)).map(([, v]) => JSON.parse(String(v)) as { cid: string; sendId?: string })
	return [...(Array.isArray(legacy) ? legacy : []), ...records]
}
const fragCount = (map: Map<string, unknown>): number => [...map.keys()].filter((k) => k.startsWith('beamio.chat.history.frag:')).length
// every append is awaited with a watchdog: a remote step that never ends is reported as `hung` (an assertion), not as a run that never finishes
const settle = async (p: Promise<void>): Promise<string> => Promise.race([p.then(() => 'resolved', (e) => (e as Error).message), new Promise<string>((r) => { const h = setTimeout(() => r('hung'), 5_000); void p.then(() => clearTimeout(h), () => clearTimeout(h)) })])

async function main(): Promise<void> {
	const keepAlive = setInterval(() => undefined, 1000) // AbortSignal.timeout timers are unref'd; a real fetch keeps the process alive, the stub does not
	// ---------------- A + B: each failing step rejects, the local copy stays, a durable pending record exists ----------------
	for (const [label, setup, expect] of [
		['upload fails (HTTP 502)', () => { net.storage = 'fail' }, 'remote_commit_failed:upload'],
		['pointer fails (HTTP 500) after both uploads', () => { net.pointer = 'fail' }, 'remote_commit_failed:pointer'],
		['upload hangs past the step timeout', () => { net.storage = 'hang' }, 'remote_commit_failed:upload'],
	] as const) {
		resetNet(); setup()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data, { timeoutMs: 60 })
		const sid = `ab-${label.slice(0, 4)}`
		// a watchdog: an append whose remote step never ends is reported as `hung` (an assertion), not as a test that never finishes
		const result = await Promise.race([settle(p.h.append(entryOf(sid, 1_700_000_000_000))), new Promise<string>((r) => setTimeout(() => r('hung'), 5_000))])
		check(`A ${label}: the inbound append REJECTS with ${expect}`, result === expect, result)
		check(`B ${label}: the index record, the fragment cache and the library row stay (nothing rolled back)`, p.priv.manifest?.records.length === 1 && fragCount(map) === 1 && (await rowsFor(p.lib, sid)) === 1)
		check(`B ${label}: a durable pending record names the sendId`, pendingOf(map).length === 1 && pendingOf(map)[0]?.sendId === sid)
		check(`B ${label}: the local index copy is durable`, map.has(`beamio.chat.history.index:${eoa}`))
	}

	// ---------------- A: success path ----------------
	{
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const result = await settle(p.h.append(entryOf('ok-1', 1_700_000_001_000)))
		check('A all three steps succeed: append resolves; fragment and index uploaded (2 uploads), pointer moved once, pending list empty', result === 'resolved' && net.storedBodies.length === 2 && net.pointerOk === 1 && pendingOf(map).length === 0, `${result} uploads=${net.storedBodies.length} pointer=${net.pointerOk}`)
		check('A the order is storage, storage, pointer (pointer last)', net.events.join(',') === 'storage_ok,storage_ok,pointer_ok', net.events.join(','))
	}

	// ---------------- C: retry then success ----------------
	{
		resetNet(); net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('c-1', 1_700_000_002_000)))
		net.pointer = 'ok'
		const again = await settle(p.h.append({ ...entryOf('c-1', 1_700_000_002_000), ts: 1_700_000_002_999 })) // the redelivery of the same message
		check('C the retry resolves once the pointer works', again === 'resolved', again)
		check('C ... with ONE index record, ONE library row, ONE local fragment and an empty pending list', p.priv.manifest?.records.length === 1 && (await rowsFor(p.lib, 'c-1')) === 1 && fragCount(map) === 1 && pendingOf(map).length === 0)
		const headBefore = headSyncs
		await settle(p.h.append(entryOf('c-1', 1_700_000_002_000)))
		check('C a redelivery of a known sendId does not pull the chain head again (the quick duplicate path)', headSyncs === headBefore)
		const calls = net.storageCalls
		const third = await settle(p.h.append(entryOf('c-1', 1_700_000_002_000)))
		check('C after success a further redelivery resolves with NO more remote traffic and no second row', third === 'resolved' && net.storageCalls === calls && (await rowsFor(p.lib, 'c-1')) === 1)
	}

	// ---------------- D: the six steps ----------------
	{
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const ack: string[] = [] // what the page's mailbox ACK would be, in order
		const log: string[] = []
		const ackAfter = async (p: Promise<void>, tag: string): Promise<string> => { const r = await settle(p); if (r === 'resolved') { ack.push(tag); log.push(`ack:${tag}`) } else log.push(`reject:${tag}`); return r }
		const sid = 'six-1'
		// 1 local copy stored (2 remote pointer fails)
		net.pointer = 'fail'
		const p1 = await process_(map, data)
		const first = await ackAfter(p1.h.append(entryOf(sid, 1_700_000_003_000)), 'first')
		check('D1 the local copy is stored (index record, fragment, library row) while the append is not confirmed', p1.priv.manifest?.records.length === 1 && fragCount(map) === 1 && (await rowsFor(p1.lib, sid)) === 1 && first === 'remote_commit_failed:pointer')
		check('D2 the remote pointer failed (and no ACK was given)', net.pointerFail === 1 && net.pointerOk === 0 && ack.length === 0)
		// 3 restart: nothing in memory survives, the persistence map and the library database do
		const p2 = await process_(map, data)
		log.push('restart')
		check('D3 after the restart the durable pending record is still there', pendingOf(map).length === 1 && pendingOf(map)[0]?.sendId === sid)
		// 4 mailbox redelivery (the pointer is still down: still no ACK)
		const redeliver1 = await ackAfter(p2.h.append({ ...entryOf(sid, 1_700_000_003_000), ts: 1_700_000_003_500 }), 'redeliver-down')
		check('D4 the redelivery while the pointer is still down is rejected (no ACK) and adds no row', redeliver1 === 'remote_commit_failed:pointer' && ack.length === 0 && (await rowsFor(p2.lib, sid)) === 1 && p2.priv.manifest?.records.length === 1)
		// 5 resume succeeds
		net.pointer = 'ok'
		const okAt = net.events.length
		const redeliver2 = await ackAfter(p2.h.append({ ...entryOf(sid, 1_700_000_003_000), ts: 1_700_000_003_900 }), 'redeliver-up')
		check('D5 the redelivery after the pointer recovered resumes the commit and resolves', redeliver2 === 'resolved' && net.pointerOk === 1 && pendingOf(map).length === 0, `${redeliver2} pointerOk=${net.pointerOk}`)
		// 6 the ACK came only now, after the pointer success
		check('D6 the ACK happened exactly once and only after the pointer success', ack.length === 1 && ack[0] === 'redeliver-up' && log.indexOf('ack:redeliver-up') === log.length - 1 && net.events.slice(okAt).includes('pointer_ok'), log.join(','))
		// one row everywhere
		check('D7 the message is ONE index record, ONE library row, ONE local fragment, and the pending list is empty', p2.priv.manifest?.records.filter((r) => r.sendId === sid).length === 1 && (await rowsFor(p2.lib, sid)) === 1 && fragCount(map) === 1 && pendingOf(map).length === 0)
		// a restart after the success and one more redelivery: still one row, no remote traffic
		const p3 = await process_(map, data)
		const calls = net.storageCalls
		const late = await settle(p3.h.append({ ...entryOf(sid, 1_700_000_003_000), ts: 1_700_000_004_500 }))
		check('D8 a later restart plus redelivery is still ONE row and causes no remote traffic', late === 'resolved' && (await rowsFor(p3.lib, sid)) === 1 && net.storageCalls === calls && p3.priv.manifest?.records.length === 1)
	}

	// ---------------- G: the step that fails is named exactly; a lost local fragment never counts as committed; a missing library row is repaired on the resume ----------------
	{
		resetNet(); net.failStorageCall = 2 // the fragment upload (call 1) works, the index upload (call 2) fails
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const r = await settle(p.h.append(entryOf('g-idx', 1_700_000_007_000)))
		check('G the INDEX upload failing is named index_upload and the pointer never moves', r === 'remote_commit_failed:index_upload' && net.pointerOk === 0 && net.pointerFail === 0, r)
	}
	{
		resetNet(); net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('g-lost', 1_700_000_008_000)))
		const cid = pendingOf(map)[0]?.cid
		map.delete(`beamio.chat.history.frag:${cid}`) // the local fragment cache lost its cipher (cleared storage)
		net.pointer = 'ok'
		const r = await settle(p.h.append(entryOf('g-lost', 1_700_000_008_000)))
		check('G a pending record whose local fragment is gone is NOT committed: the resume rejects (no_fragment), the pointer does not move, the pending record stays', r === 'remote_commit_failed:no_fragment' && net.pointerOk === 0 && pendingOf(map).length === 1, r)
	}
	{
		resetNet(); net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const realIngest = p.lib.ingest.bind(p.lib)
		let failRow = true
		;(p.lib as unknown as { ingest: (r: never) => Promise<string> }).ingest = async (r: never) => { if (failRow) throw new Error('library write failed (synthetic)'); return realIngest(r) }
		const first = await settle(p.h.append(entryOf('g-row', 1_700_000_009_000)))
		check('G the first append fails (library row not written) with the record in the index and the commit pending', first !== 'resolved' && p.priv.manifest?.records.length === 1 && pendingOf(map).length === 1, first)
		failRow = false; net.pointer = 'ok'
		const p2 = await process_(map, data)
		const second = await settle(p2.h.append(entryOf('g-row', 1_700_000_009_000)))
		check('G the redelivery repairs the missing library row (exactly one) AND resumes the commit; only then it resolves', second === 'resolved' && (await rowsFor(p2.lib, 'g-row')) === 1 && net.pointerOk === 1 && pendingOf(map).length === 0, `${second} rows=${await rowsFor(p2.lib, 'g-row')}`)
	}

	// ---------------- H: the hook-only fault option (qaRemoteFault): honoured only when the build is a hook build; a product build ignores it ----------------
	{
		const saved = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		try {
			delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
			resetNet()
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p = await process_(map, data)
			const ignored = await settle(p.h.append(entryOf('h-prod', 1_700_000_010_000), { qaRemoteFault: 'pointer' }))
			check('H a product build (no hook flag) IGNORES the fault option: the append resolves and the pointer moved', ignored === 'resolved' && net.pointerOk === 1, ignored)
			process.env.REACT_APP_QA_ACK_ORDER_HOOK = 'true'
			resetNet()
			const map2 = new Map<string, unknown>(); const data2 = new MemoryData()
			const q = await process_(map2, data2, { timeoutMs: 50 })
			for (const [fault, expect] of [['pointer', 'remote_commit_failed:pointer'], ['upload', 'remote_commit_failed:upload'], ['timeout', 'remote_commit_failed:pointer']] as const) {
				const r = await settle(q.h.append(entryOf(`h-${fault}`, 1_700_000_010_100), { qaRemoteFault: fault }))
				check(`H hook build, fault ${fault}: the append rejects with ${expect} and no request went out (${net.storageCalls} storage calls, ${net.pointerOk + net.pointerFail} pointer calls)`, r === expect && net.storageCalls === 0 && net.pointerOk + net.pointerFail === 0, r)
			}
			check('H a faulted append still leaves the local index on disk (the local copy comes first, whatever the remote does)', map2.has(`beamio.chat.history.index:${eoa}`))
			const resumed = await settle(q.h.append(entryOf('h-pointer', 1_700_000_010_100))) // switch off: the redelivery resumes through the real remote
			check('H switch off: the redelivery of the failed record resumes through the real path and resolves, one record, one row', resumed === 'resolved' && net.pointerOk === 1 && (await rowsFor(q.lib, 'h-pointer')) === 1 && q.priv.manifest?.records.filter((r) => r.sendId === 'h-pointer').length === 1, resumed)
		} finally {
			if (saved === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
			else process.env.REACT_APP_QA_ACK_ORDER_HOOK = saved
		}
	}

	// ---------------- E: no remote needed ----------------
	{
		resetNet(); net.storage = 'fail'; net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const out = await settle(p.h.append(entryOf('out-1', 1_700_000_005_000, 'out')))
		check('E an OUTBOUND mirror stays best effort: resolves although the remote is down; no pointer moves and the record stays pending until its content has been uploaded and read back', out === 'resolved' && net.pointerOk === 0 && net.pointerFail === 0 && pendingOf(map).length === 1, `${out} pending=${pendingOf(map).length}`)
		const q = await process_(new Map<string, unknown>(), new MemoryData(), { apiBaseUrl: '' })
		const noApi = await settle(q.h.append(entryOf('noapi-1', 1_700_000_006_000)))
		check('E a store without apiBaseUrl has no remote: an inbound append resolves', noApi === 'resolved')
	}

	// ---------------- I: all THREE (local copy on disk, fragment upload, pointer) or no confirmation; the durable pending list is never read as "empty" when it cannot be read ----------------
	{
		resetNet()
		const indexKeyName = `beamio.chat.history.index:${eoa}`
		let diskFails = true
		const map = new (class extends Map<string, unknown> {
			override set(k: string, v: unknown): this { if (diskFails && k === indexKeyName) throw new Error('local index write failed (synthetic)'); return super.set(k, v) }
		})()
		const data = new MemoryData()
		const p = await process_(map, data)
		const first = await settle(p.h.append(entryOf('i-disk', 1_700_000_011_000)))
		check('I1 the local index cannot be written: the inbound append rejects', first !== 'resolved', first)
		const retry = await settle(p.h.append(entryOf('i-disk', 1_700_000_011_000)))
		check('I1 the retry in the same worker does NOT confirm while the local index is still not on disk, although the remote works', retry !== 'resolved' && !map.has(indexKeyName) && pendingOf(map).length === 1, retry)
		diskFails = false
		const healed = await settle(p.h.append(entryOf('i-disk', 1_700_000_011_000)))
		check('I1 once the disk works the retry confirms: local index on disk, one record, one row, pending empty', healed === 'resolved' && map.has(indexKeyName) && p.priv.manifest?.records.length === 1 && (await rowsFor(p.lib, 'i-disk')) === 1 && pendingOf(map).length === 0, healed)
	}
	{
		resetNet(); net.pointer = 'fail'
		let readFails = false
		const map = new (class extends Map<string, unknown> {
			override get(k: string): unknown { if (readFails && k === PENDING_KEY) throw new Error('pending read failed (synthetic)'); return super.get(k) }
		})()
		const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('i-read', 1_700_000_012_000)))
		net.pointer = 'ok'; readFails = true
		const p2 = await process_(map, data)
		const r = await settle(p2.h.append(entryOf('i-read', 1_700_000_012_000)))
		check('I2 the pending list cannot be READ: the redelivery is not confirmed (a failed read is not an empty list), the pointer does not move', r !== 'resolved' && net.pointerOk === 0, r)
		readFails = false
		const again = await settle(p2.h.append(entryOf('i-read', 1_700_000_012_000)))
		check('I2 once it reads again the redelivery resumes the commit and confirms', again === 'resolved' && net.pointerOk === 1 && pendingOf(map).length === 0, again)
	}
	for (const [label, bad] of [['text that is not JSON', '{bad'], ['JSON that is not a list', '{"cid":"x"}'], ['a list with an entry without a cid', '[{"sendId":"i-bad"}]']] as const) {
		resetNet(); net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('i-bad', 1_700_000_013_000)))
		net.pointer = 'ok'
		map.set(PENDING_KEY, bad)
		const p2 = await process_(map, data)
		const dup = await settle(p2.h.append(entryOf('i-bad', 1_700_000_013_000)))
		const other = await settle(p2.h.append(entryOf('i-bad-2', 1_700_000_013_001)))
		check(`I3 a damaged pending list (${label}): neither the redelivery nor a new inbound append is confirmed, and the damaged value is NOT overwritten`, dup !== 'resolved' && other !== 'resolved' && net.pointerOk === 0 && map.get(PENDING_KEY) === bad, `${dup} / ${other}`)
	}

	// ---------------- J: an OUTBOUND mirror never publishes (pointer) an index that names an inbound record whose fragment is not uploaded ----------------
	{
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		net.storage = 'fail'
		await settle(p.h.append(entryOf('j-in', 1_700_000_014_000)))
		const inboundFrag = String(map.get(`beamio.chat.history.frag:${pendingOf(map)[0]?.cid}`))
		net.storage = 'ok'; net.failBody = inboundFrag // everything uploads now EXCEPT the pending inbound fragment
		const out = await settle(p.h.append(entryOf('j-out', 1_700_000_014_001, 'out')))
		check('J1 the outbound mirror still resolves and the local index keeps both records, but the pointer does NOT move while the pending inbound fragment cannot be uploaded; the pending entry stays', out === 'resolved' && p.priv.manifest?.records.length === 2 && map.has(`beamio.chat.history.index:${eoa}`) && net.pointerOk === 0 && net.pointerFail === 0 && pendingOf(map).length === 1, `${out} pointerOk=${net.pointerOk}`)
		net.failBody = ''; net.storedBodies = []; net.events = []
		await settle(p.h.append(entryOf('j-out-2', 1_700_000_014_002, 'out')))
		check('J2 once it can: the pending inbound fragment is uploaded BEFORE the pointer moves; the inbound entry stays pending until its own commit', net.pointerOk === 1 && net.storedBodies.includes(inboundFrag) && net.events[net.events.length - 1] === 'pointer_ok' && pendingOf(map).length === 1, `pointerOk=${net.pointerOk} events=${net.events.join(',')}`)
		const redelivered = await settle(p.h.append(entryOf('j-in', 1_700_000_014_000)))
		check('J3 the redelivery then commits and confirms, one record', redelivered === 'resolved' && pendingOf(map).length === 0 && p.priv.manifest?.records.filter((r) => r.sendId === 'j-in').length === 1, redelivered)
	}
	{
		resetNet()
		let readFails = false
		const map = new (class extends Map<string, unknown> {
			override get(k: string): unknown { if (readFails && k === PENDING_KEY) throw new Error('pending read failed (synthetic)'); return super.get(k) }
		})()
		const p = await process_(map, new MemoryData())
		readFails = true
		const out = await settle(p.h.append(entryOf('j-unread', 1_700_000_014_100, 'out')))
		check('J4 the pending list cannot be read: an outbound mirror moves no pointer (it cannot know the index is complete)', out === 'resolved' && net.pointerOk === 0, `${out} pointerOk=${net.pointerOk}`)
	}

	// ---------------- K: the manifest is replaced while an append is running (another read of the local index / a head sync): nothing is confirmed or forgotten for a record the published index does not hold ----------------
	{
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('k-first', 1_700_000_015_000)))
		const realEnsure = (p.priv.ensureLocal as () => Promise<unknown>).bind(p.h)
		let reload = true
		p.priv.ensureLocal = async () => {
			// between the record push and the commit: the local index on disk (without the new record) replaces the manifest, as a concurrent load() does
			if (reload) { reload = false; await (p.priv.loadLocalManifest as () => Promise<unknown>).call(p.h) }
			return realEnsure()
		}
		const pointerBefore = net.pointerOk
		const r = await settle(p.h.append(entryOf('k-lost', 1_700_000_015_001)))
		check('K1 the manifest was replaced mid-append: the append is NOT confirmed, the pointer does not move for it, its pending entry stays', r !== 'resolved' && net.pointerOk === pointerBefore && pendingOf(map).some((x) => x.sendId === 'k-lost'), r)
		const again = await settle(p.h.append(entryOf('k-lost', 1_700_000_015_001)))
		check('K2 the retry stores it again and commits: one record, one row, nothing pending', again === 'resolved' && p.priv.manifest?.records.filter((x) => x.sendId === 'k-lost').length === 1 && (await rowsFor(p.lib, 'k-lost')) === 1 && pendingOf(map).length === 0, `${again} rows=${await rowsFor(p.lib, 'k-lost')}`)
	}
	{
		resetNet(); net.pointer = 'fail'
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		await settle(p.h.append(entryOf('k-a', 1_700_000_016_000)))
		net.pointer = 'ok'
		// the manifest is handed back WITHOUT the pending record, once, at the start of the next append
		let dropOnce = true
		p.priv.syncFromHeadUnlocked = async () => { if (!dropOnce) return false; dropOnce = false; p.priv.manifest = { ...(p.priv.manifest as object), records: [] } as never; return true }
		const b = await settle(p.h.append(entryOf('k-b', 1_700_000_016_001)))
		check('K3 another record commits, but the pending record that the published index does not hold is NOT cleared', b === 'resolved' && pendingOf(map).length === 1 && pendingOf(map)[0]?.sendId === 'k-a', `${b} pending=${pendingOf(map).map((x) => x.sendId).join(',')}`)
		p.priv.syncFromHeadUnlocked = async () => false
		const a = await settle(p.h.append(entryOf('k-a', 1_700_000_016_000)))
		check('K4 its redelivery stores it again and commits it; nothing pending, one library row', a === 'resolved' && pendingOf(map).length === 0 && (await rowsFor(p.lib, 'k-a')) === 1 && p.priv.manifest?.records.some((x) => x.sendId === 'k-a') === true, a)
	}

	// ---------------- L: the TWO gates of the hook-only fault option, each observed on its own boundary (either one alone would hide the loss of the other) ----------------
	{
		const saved = process.env.REACT_APP_QA_ACK_ORDER_HOOK
		try {
			delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
			resetNet(); net.pointer = 'fail'
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p = await process_(map, data)
			const real = (p.priv.commitRemoteAll as (...a: unknown[]) => Promise<string>).bind(p.h)
			const seen: unknown[] = []
			p.priv.commitRemoteAll = async (...a: unknown[]) => { seen.push(a[0]); return real(...a) }
			await settle(p.h.append(entryOf('l-gate', 1_700_000_017_000), { qaRemoteFault: 'pointer' })) // the new-record path
			await settle(p.h.append(entryOf('l-gate', 1_700_000_017_000), { qaRemoteFault: 'upload' })) // the duplicate (resume) path
			check('L1 append gate: without the hook flag the inner commit receives NO fault on the new-record path and on the resume path', seen.length === 2 && seen.every((x) => x === undefined), JSON.stringify(seen))
			net.pointer = 'ok'
			const calls = net.storageCalls
			const inner = await real('pointer')
			check('L2 commit gate: without the hook flag a fault handed straight to the inner commit is ignored: the real remote path runs (uploads, pointer moved, nothing pending)', inner === 'ok' && net.storageCalls > calls && net.pointerOk === 1 && pendingOf(map).length === 0, `${inner} pointerOk=${net.pointerOk}`)
		} finally {
			if (saved === undefined) delete process.env.REACT_APP_QA_ACK_ORDER_HOOK
			else process.env.REACT_APP_QA_ACK_ORDER_HOOK = saved
		}
	}

	// ---------------- M: read-back after upload. A success status of the upload is not enough: the content is read back by its hash (bypassing caches) and must be byte for byte what was uploaded, otherwise no pointer and no confirmation ----------------
	const cases: Array<[string, () => void]> = [
		['the upload answers success but nothing was saved', () => { net.save = false }],
		['the read-back finds nothing', () => { net.read = 'missing' }],
		['the read-back hangs past the step timeout', () => { net.read = 'hang' }],
		['the read-back answers non-2xx', () => { net.read = 'http500' }],
		['the read-back returns different bytes', () => { net.read = 'differs' }],
		['the read-back returns one extra byte', () => { net.read = 'extra_byte' }],
		['the read-back returns only a part', () => { net.read = 'partial' }],
	]
	for (const [i, [label, setup]] of cases.entries()) {
		resetNet(); setup()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data, { timeoutMs: 60 })
		const sid = `m-${i}`
		const r = await Promise.race([settle(p.h.append(entryOf(sid, 1_700_000_020_000 + i))), new Promise<string>((res) => setTimeout(() => res('hung'), 5_000))])
		check(`M ${label}: the inbound append is not confirmed (upload failure), the pointer does not move`, r === 'remote_commit_failed:upload' && net.pointerOk === 0 && net.pointerFail === 0, `${r} pointer=${net.pointerOk}`)
		check(`M ${label}: the local copy stays and the record stays pending`, p.priv.manifest?.records.length === 1 && fragCount(map) === 1 && (await rowsFor(p.lib, sid)) === 1 && pendingOf(map).length === 1)
		const again = await settle(p.h.append(entryOf(sid, 1_700_000_020_000 + i)))
		check(`M ${label}: the retry is refused the same way (resume path)`, again === 'remote_commit_failed:upload' && net.pointerOk === 0, again)
		// the retry uploads the SAME content (same hash): its read-back must not reuse a URL an HTTP cache may already hold
		if (net.reads.length) check(`M ${label}: two read-backs of the same content use two different URLs`, net.reads.length >= 2 && new Set(net.reads.map((x) => x.url)).size === net.reads.length, `reads=${net.reads.length} urls=${new Set(net.reads.map((x) => x.url)).size}`)
		net.save = true; net.read = 'ok'
		const p2 = await process_(map, data, { timeoutMs: 60 })
		const healed = await settle(p2.h.append(entryOf(sid, 1_700_000_020_000 + i)))
		check(`M ${label}: once the content reads back, the resume after a restart commits and confirms: ONE record, ONE row, nothing pending`, healed === 'resolved' && net.pointerOk === 1 && p2.priv.manifest?.records.filter((x) => x.sendId === sid).length === 1 && (await rowsFor(p2.lib, sid)) === 1 && pendingOf(map).length === 0, healed)
	}
	{
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const r = await settle(p.h.append(entryOf('m-ok', 1_700_000_021_000)))
		check('M every upload is read back (fragment and index), with the HTTP cache off and a different URL each time', r === 'resolved' && net.reads.length === 2 && net.reads.every((x) => x.cache === 'no-store') && new Set(net.reads.map((x) => x.url)).size === 2, `${r} reads=${net.reads.length}`)
		const first = net.reads[0]?.url
		await settle(p.h.append(entryOf('m-ok-2', 1_700_000_021_001)))
		check('M no read-back URL is ever reused', new Set(net.reads.map((x) => x.url)).size === net.reads.length && net.reads.filter((x) => x.url === first).length === 1)
	}
	{
		// a cached good answer under the plain URL must not stand in for the server
		resetNet(); net.save = false
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const realFetch = globalThis.fetch
		globalThis.fetch = (async (u: string, init?: { body?: string; cache?: string; signal?: AbortSignal }) => {
			if (String(u).endsWith('/storageFragment')) {
				const image = String((JSON.parse(String(init?.body)) as { image: string }).image)
				net.httpCache.set(`https://ipfs.test/getFragment?hash=${ethers.keccak256(ethers.toUtf8Bytes(image))}`, image)
			}
			return realFetch(u as never, init as never)
		}) as never
		const r = await settle(p.h.append(entryOf('m-cache', 1_700_000_022_000)))
		globalThis.fetch = realFetch
		check('M a cached copy (and the local fragment cache, which holds the content) is not accepted as the read-back', r === 'remote_commit_failed:upload' && net.pointerOk === 0 && fragCount(map) === 1, r)
	}
	{
		// the index is checked too: the fragment reads back, the index does not
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const realFetch = globalThis.fetch
		let posts = 0
		globalThis.fetch = (async (u: string, init?: never) => { if (String(u).endsWith('/storageFragment')) { posts += 1; net.save = posts !== 2 } return realFetch(u as never, init) }) as never
		const r = await settle(p.h.append(entryOf('m-index', 1_700_000_023_000)))
		globalThis.fetch = realFetch
		check('M the INDEX that does not read back is named index_upload and the pointer does not move', r === 'remote_commit_failed:index_upload' && net.pointerOk === 0, r)
	}
	{
		// OUTBOUND: its own fragment that does not read back must not be named by a published index
		resetNet()
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		net.save = false
		const out = await settle(p.h.append(entryOf('m-out', 1_700_000_024_000, 'out')))
		check('M outbound: the mirror resolves (local copy), NO pointer moves, and the record stays pending', out === 'resolved' && net.pointerOk === 0 && net.pointerFail === 0 && pendingOf(map).some((x) => x.sendId === 'm-out'), `${out} pointer=${net.pointerOk}`)
		// only the outbound fragment stays unreadable while the next index would read back
		const outFrag = String(map.get(`beamio.chat.history.frag:${pendingOf(map)[0]?.cid}`))
		net.save = true; net.failBody = outFrag
		await settle(p.h.append(entryOf('m-out-2', 1_700_000_024_001, 'out')))
		check('M outbound: a later mirror publishes no index while the earlier fragment cannot be uploaded', net.pointerOk === 0, `pointer=${net.pointerOk}`)
		net.failBody = ''
		const inb = await settle(p.h.append(entryOf('m-in-after', 1_700_000_024_002)))
		check('M once it reads back: the next inbound commit uploads it, moves the pointer and clears the pending list', inb === 'resolved' && net.pointerOk === 1 && pendingOf(map).length === 0 && net.saved.has(ethers.keccak256(ethers.toUtf8Bytes(outFrag))), `${inb} pointer=${net.pointerOk}`)
	}

	// ---------------- N: the pointer answer counts only when its JSON body has success === true ----------------
	for (const [i, [label, body]] of ([['200 with success:false', '{"success":false,"error":"synthetic"}'], ['200 that is not JSON', 'OK'], ['200 with an empty body', ''], ['200 without the field', '{}'], ['200 with success as text', '{"success":"true"}'], ['200 with a JSON that is not an object', 'true'], ['200 with null', 'null']] as const).entries()) {
		resetNet(); net.pointerBody = body
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p = await process_(map, data)
		const sid = `n-${i}`
		const r = await settle(p.h.append(entryOf(sid, 1_700_000_030_000 + i)))
		check(`N ${label}: the inbound append is not confirmed and the record stays pending`, r === 'remote_commit_failed:pointer' && pendingOf(map).length === 1, `${r} pending=${pendingOf(map).length}`)
		const again = await settle(p.h.append(entryOf(sid, 1_700_000_030_000 + i)))
		check(`N ${label}: the retry is refused the same way`, again === 'remote_commit_failed:pointer' && pendingOf(map).length === 1, again)
		net.pointerBody = POINTER_OK
		const p2 = await process_(map, data)
		const healed = await settle(p2.h.append(entryOf(sid, 1_700_000_030_000 + i)))
		check(`N ${label}: after a restart a success:true answer commits it: one record, one row, nothing pending`, healed === 'resolved' && pendingOf(map).length === 0 && p2.priv.manifest?.records.filter((x) => x.sendId === sid).length === 1 && (await rowsFor(p2.lib, sid)) === 1, healed)
	}

	// ---------------- P: before ANY publication the local index is brought up to the head; a head that cannot be read or merged means: publish nothing, keep pending, do not confirm ----------------
	{
		const head = async (p: { priv: Record<string, unknown> }): Promise<string[]> => {
			const cipher = net.saved.get(chain.hash)
			if (!cipher) return []
			return (JSON.parse(await aesGcmDecryptString(p.priv.indexKey as never, cipher)) as { records: Array<{ sendId: string }> }).records.map((r) => r.sendId).sort()
		}
		const device = () => ({ map: new Map<string, unknown>(), data: new MemoryData() })
		const start = () => { resetNet(); Object.assign(chain, { on: true, hash: '', seq: 0, readFails: false }) }
		try {
			{
				start()
				const d1 = device(); const d2 = device()
				const two = await process_(d2.map, d2.data, { realHead: true })
				net.pointer = 'fail'
				await settle(two.h.append(entryOf('p-late', 1_700_000_040_000)))
				net.pointer = 'ok'
				const one = await process_(d1.map, d1.data, { realHead: true })
				for (let i = 0; i < 3; i++) await settle(one.h.append(entryOf(`p-other-${i}`, 1_700_000_040_100 + i)))
				const r = await settle(two.h.append(entryOf('p-late', 1_700_000_040_000)))
				const names = await head(two)
				check('P1 local index BEHIND the head, resume path: it syncs first, then commits; the head names every record of both devices', r === 'resolved' && names.join(',') === 'p-late,p-other-0,p-other-1,p-other-2' && chain.seq >= 4, `${r} head=${names.join(',')} seq=${chain.seq}`)
			}
			{
				start()
				const d1 = device(); const d2 = device()
				const two = await process_(d2.map, d2.data, { realHead: true })
				net.pointer = 'fail'
				for (let i = 0; i < 3; i++) await settle(two.h.append(entryOf(`p-mine-${i}`, 1_700_000_041_000 + i)))
				net.pointer = 'ok'
				const one = await process_(d1.map, d1.data, { realHead: true })
				await settle(one.h.append(entryOf('p-theirs', 1_700_000_041_100)))
				const r = await settle(two.h.append(entryOf('p-mine-0', 1_700_000_041_000)))
				const names = await head(two)
				check('P2 a resume with MORE local records than the head never replaces the head with a list that lacks another device\'s record', r === 'resolved' && names.includes('p-theirs') && names.length === 4, `${r} head=${names.join(',')}`)
			}
			for (const [i, [label, breakIt, heal]] of ([
				['the head index cannot be fetched', () => { net.read = 'ok'; const keep = net.saved.get(chain.hash)!; net.saved.delete(chain.hash); (chain as unknown as { keep: string }).keep = keep }, () => { net.saved.set(chain.hash, (chain as unknown as { keep: string }).keep) }],
				['the head pointer cannot be read', () => { chain.readFails = true }, () => { chain.readFails = false }],
				['the head index cannot be decrypted', () => { (chain as unknown as { keep: string }).keep = net.saved.get(chain.hash)!; net.saved.set(chain.hash, 'bm90IGFuIGluZGV4') }, () => { net.saved.set(chain.hash, (chain as unknown as { keep: string }).keep) }],
			] as Array<[string, () => void, () => void]>).entries()) {
				for (const path of ['new record', 'resume', 'outbound'] as const) {
					start()
					const d1 = device(); const d2 = device()
					const two = await process_(d2.map, d2.data, { realHead: true })
					net.pointer = 'fail'
					await settle(two.h.append(entryOf('p-a', 1_700_000_042_000)))
					await settle(two.h.append(entryOf('p-b', 1_700_000_042_001)))
					net.pointer = 'ok'
					const one = await process_(d1.map, d1.data, { realHead: true })
					await settle(one.h.append(entryOf('p-theirs', 1_700_000_042_100 + i)))
					const hashBefore = chain.hash
					const okBefore = net.pointerOk; const failBefore = net.pointerFail
					breakIt()
					const subject = path === 'resume' ? entryOf('p-a', 1_700_000_042_000) : entryOf('p-new', 1_700_000_042_200, path === 'outbound' ? 'out' : 'in')
					const r = await settle(two.h.append(subject))
					const confirmedRight = path === 'outbound' ? r === 'resolved' : r.startsWith('remote_commit_failed:')
					check(`P3 ${label}, ${path}: no pointer request at all, ${path === 'outbound' ? 'the mirror keeps its local copy' : 'not confirmed'}, the record stays pending`, confirmedRight && chain.hash === hashBefore && net.pointerOk === okBefore && net.pointerFail === failBefore && pendingOf(d2.map).some((x) => x.sendId === subject.sendId), `${r} pointer=${net.pointerOk - okBefore}/${net.pointerFail - failBefore}`)
					heal()
					const after = await settle(two.h.append(path === 'outbound' ? entryOf('p-a', 1_700_000_042_000) : subject))
					const names = await head(two)
					check(`P3 ${label}, ${path}: once the head is readable the commit goes through and the head holds both devices' records, one of each`, after === 'resolved' && ['p-a', 'p-b', 'p-theirs', subject.sendId].every((n) => names.filter((x) => x === n).length === 1), `${after} head=${names.join(',')}`)
				}
			}
			{
				// a head that needs re-linearising while one of its fragments is gone: nothing is published over it
				start()
				const d1 = device(); const d2 = device()
				const two = await process_(d2.map, d2.data, { realHead: true })
				net.pointer = 'fail'
				for (let i = 0; i < 2; i++) await settle(two.h.append(entryOf(`p-c-${i}`, 1_700_000_043_000 + i)))
				net.pointer = 'ok'
				const one = await process_(d1.map, d1.data, { realHead: true })
				await settle(one.h.append(entryOf('p-gone', 1_700_000_043_100)))
				const hashBefore = chain.hash
				const theirs = [...net.saved.entries()].filter(([k]) => k !== chain.hash)
				for (const [k] of theirs) if (one.priv.manifest!.records.some((x) => x.cid === k)) net.saved.delete(k)
				const r = await settle(two.h.append(entryOf('p-c-0', 1_700_000_043_000)))
				check('P4 re-linearisation needs a fragment that cannot be fetched: the head is not replaced, not confirmed, pending kept', r.startsWith('remote_commit_failed:') && chain.hash === hashBefore && pendingOf(d2.map).length === 2, r)
			}
			{
				// the REAL pointer read: a failed RPC call is not "there is no head"
				start()
				const d2 = device()
				const two = await process_(d2.map, d2.data)
				delete (two.priv as Record<string, unknown>).syncFromHeadUnlocked
				two.priv.provider = { call: async () => { throw new Error('rpc down (synthetic)') } }
				const r = await settle(two.h.append(entryOf('p-rpc', 1_700_000_044_000)))
				check('P5 the real pointer read fails: nothing is published, not confirmed, pending kept', r === 'remote_commit_failed:head_unsynced' && net.pointerOk === 0 && net.pointerFail === 0 && pendingOf(d2.map).length === 1, `${r} pointer=${net.pointerOk}/${net.pointerFail}`)
			}
			{
				// a head index that decrypts but belongs to another wallet
				start()
				const d1 = device(); const d2 = device()
				const one = await process_(d1.map, d1.data, { realHead: true })
				await settle(one.h.append(entryOf('p-w', 1_700_000_045_000)))
				const other = await aesGcmEncryptString(one.priv.indexKey as never, JSON.stringify({ v: 1, eoa: `0x${'33'.repeat(20)}`, updatedAt: 1, records: [] }))
				chain.hash = ethers.keccak256(ethers.toUtf8Bytes(other)); net.saved.set(chain.hash, other)
				const hashBefore = chain.hash
				const two = await process_(d2.map, d2.data, { realHead: true })
				const r = await settle(two.h.append(entryOf('p-w2', 1_700_000_045_001)))
				check('P6 the head index names another wallet: nothing is published over it, not confirmed', r === 'remote_commit_failed:head_unsynced' && chain.hash === hashBefore, r)
			}
			{
				// the head sync has to publish the merged list itself and that publication fails: the older local list must not be published afterwards
				start()
				const d1 = device(); const d2 = device()
				const two = await process_(d2.map, d2.data, { realHead: true })
				net.pointer = 'fail'
				await settle(two.h.append(entryOf('p-m', 1_700_000_046_000)))
				net.pointer = 'ok'
				const one = await process_(d1.map, d1.data, { realHead: true })
				await settle(one.h.append(entryOf('p-m-theirs', 1_700_000_046_100)))
				const hashBefore = chain.hash
				const realFetch = globalThis.fetch
				let failed = false
				globalThis.fetch = (async (u: string, init?: never) => { if (!failed && String(u).endsWith('/setChatIndexPointer')) { failed = true; return new Response('{"success":false}', { status: 200 }) } return realFetch(u as never, init) }) as never
				const r = await settle(two.h.append(entryOf('p-m', 1_700_000_046_000)))
				globalThis.fetch = realFetch
				check('P7 the merged head could not be published: no later publication in the same commit, not confirmed, the head is unchanged', r === 'remote_commit_failed:head_unsynced' && chain.hash === hashBefore && pendingOf(d2.map).length === 1, r)
			}
		} finally {
			chain.on = false
		}
	}

	clearInterval(keepAlive)
	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
