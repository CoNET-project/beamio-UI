/**
 * Two and three "tabs" (HistoryStore instances) over ONE persistence map: no pending record is lost and nothing is confirmed without a published head that holds it. Real HistoryStore.append; the network is
 * stubbed at fetch level; synthetic wallet and rows. Run: npx tsx scripts/testHistoryTwoTabs.ts
 */
import { ethers } from 'ethers'
import { HistoryStore } from '../src/worker/history.js'
import { aesGcmDecryptString } from '../src/crypto.js'
import { sharedLockFor } from './fixtures/historyHarness.js'

let failures = 0
let passes = 0
const check = (name: string, ok: boolean, detail?: string): void => {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` - ${detail}` : ''}`)
}
const wallet = ethers.Wallet.createRandom()
const eoa = wallet.address.toLowerCase()
const peer = '0x' + '22'.repeat(20)
const saved = new Map<string, string>()
const chain = { hash: '', nonce: 0 }
const net = { pointer: 'ok' as 'ok' | 'fail' | 'lost', pointerOk: 0, signedOverMovedHead: 0, onUpload: null as null | (() => Promise<void>) }
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
	const u = String(url)
	if (u.includes('/getFragment?')) {
		const body = saved.get(new URL(u).searchParams.get('hash') ?? '')
		return new Response(body ?? '', { status: body === undefined ? 404 : 200 })
	}
	if (u.endsWith('/storageFragment')) {
		const image = String((JSON.parse(String(init?.body)) as { image: string }).image)
		saved.set(ethers.keccak256(ethers.toUtf8Bytes(image)), image)
		const hook = net.onUpload; if (hook) { net.onUpload = null; await hook() }
		return new Response('{}', { status: 200 })
	}
	if (u.endsWith('/setChatIndexPointer')) {
		if (net.pointer === 'fail') return new Response('x', { status: 500 })
		const sent = JSON.parse(String(init?.body)) as { indexHash: string; nonce: string }
		if (sent.nonce !== String(chain.nonce)) return new Response('{"success":false}', { status: 200 })
		chain.hash = sent.indexHash; chain.nonce += 1; net.pointerOk += 1
		if (net.pointer === 'lost') throw new Error('the answer never arrived')
		return new Response('{"success":true}', { status: 200 })
	}
	throw new Error(`unexpected fetch ${u}`)
}) as never

type Store = { append(e: unknown): Promise<void> }
/** one tab: `slow` delays its writes of some documents, to force an interleaving */
async function tab(map: Map<string, unknown>, opts: { lock?: boolean; slow?: (key: string) => number } = {}): Promise<Store & Record<string, unknown>> {
	const persistence = {
		get: async (k: string) => map.get(k),
		set: async (k: string, v: unknown) => { const ms = opts.slow?.(k) ?? 0; if (ms) await new Promise((r) => setTimeout(r, ms)); map.set(k, v) },
		delete: async (k: string) => void map.delete(k),
		keys: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)),
	}
	const h = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined } as never,
		{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: persistence as never, ...(opts.lock === false ? {} : { accountLock: sharedLockFor(map) }) },
	)
	await h.init()
	const priv = h as unknown as Record<string, unknown> & Store
	priv.readOnchainPointer = async () => (chain.hash ? { indexHash: chain.hash, ts: 1n, seq: 1n } : null)
	priv.readPublishSnapshot = async () => ({ head: chain.hash || null, nonce: BigInt(chain.nonce) })
	priv.ensureLocal = async () => { throw new Error('no library in this script') }
	priv.requireRowOrThrow = async () => undefined
	priv.ingestLocalAppend = async () => true
	priv.ensureLibraryRow = async () => undefined
	return priv
}
const entry = (sendId: string, ts: number, dir: 'in' | 'out' = 'in') => ({ peer, dir, ts, sendId, body: JSON.stringify({ sendId, text: `synthetic-${sendId}` }) })
const settle = (p: Promise<void>) => p.then(() => 'resolved', (e) => (e as Error).message)
const pending = (map: Map<string, unknown>) => [...map].filter(([k]) => k.startsWith(`beamio.chat.history.pendingrec:${eoa}:`)).map(([, v]) => (JSON.parse(String(v)) as { sendId: string }).sendId).sort()
async function headIds(): Promise<string> {
	if (!chain.hash) return ''
	const t = await tab(new Map()) as unknown as { indexKey: Uint8Array }
	const m = JSON.parse(await aesGcmDecryptString(t.indexKey, saved.get(chain.hash)!)) as { records: Array<{ sendId: string }> }
	return m.records.map((r) => r.sendId).sort().join(',')
}
const reset = () => { saved.clear(); chain.hash = ''; chain.nonce = 0; net.pointer = 'ok'; net.pointerOk = 0; net.onUpload = null }

async function main(): Promise<void> {
	const slowFor = (pendingMs: number, indexMs: number) => (k: string) => (k.includes('.pending') ? pendingMs : k.startsWith('beamio.chat.history.index:') ? indexMs : 0)
	for (const lock of [true, false]) {
		const name = lock ? 'with the account lock' : 'WITHOUT a lock'
		reset(); net.pointer = 'fail'
		const map = new Map<string, unknown>()
		const a = await tab(map, { lock, slow: slowFor(1, 60) }); const b = await tab(map, { lock, slow: slowFor(15, 0) }); const c = await tab(map, { lock, slow: slowFor(5, 30) })
		await Promise.all([settle(a.append(entry('A', 1_700_000_300_000))), settle(b.append(entry('B', 1_700_000_300_001))), settle(c.append(entry('C', 1_700_000_300_002)))])
		check(`three tabs, ${name}: all three pending records are kept`, pending(map).join() === 'A,B,C', pending(map).join())
		const fresh = await tab(map, { lock })
		const again = await settle(fresh.append(entry('A', 1_700_000_300_000)))
		check(`three tabs, ${name}: after a reload the redelivery of A is NOT confirmed while no publication ever succeeded`, again !== 'resolved' && net.pointerOk === 0, again)
		net.pointer = 'ok'
		const results: string[] = []
		for (const id of ['A', 'B', 'C']) results.push(await settle((await tab(map, { lock })).append(entry(id, 1_700_000_300_000 + 'ABC'.indexOf(id)))))
		if (lock) check('once the pointer works every one of them is confirmed, the head names all three once, nothing is left pending', results.every((r) => r === 'resolved') && (await headIds()) === 'A,B,C' && pending(map).length === 0, `${results} head=${await headIds()} pending=${pending(map)}`)
		else check('without a lock nothing is ever published or confirmed (the local copies and pending records stay)', results.every((r) => r !== 'resolved') && net.pointerOk === 0 && chain.hash === '' && [...new Set(pending(map))].join() === 'A,B,C', `${results} pointerOk=${net.pointerOk} pending=${pending(map)}`)
	}
	{ // a pending entry that disappeared proves nothing
		reset(); net.pointer = 'fail'
		const map = new Map<string, unknown>()
		await settle((await tab(map)).append(entry('gone', 1_700_000_301_000)))
		for (const k of [...map.keys()]) if (k.includes('.pending')) map.delete(k)
		const r = await settle((await tab(map)).append(entry('gone', 1_700_000_301_000)))
		check('a record that no pending list names, and no published head holds, is NOT confirmed', r !== 'resolved' && net.pointerOk === 0, r)
	}
	{ // killed after the pointer moved, before anything was recorded; and a lost answer
		reset(); net.pointer = 'lost'
		const map = new Map<string, unknown>()
		const first = await settle((await tab(map)).append(entry('lost', 1_700_000_302_000)))
		const submits = net.pointerOk
		net.pointer = 'ok'
		const second = await settle((await tab(map)).append(entry('lost', 1_700_000_302_000)))
		check('the pointer landed but its answer was lost: not confirmed then; after a reload the head itself is the evidence, nothing is published again', first !== 'resolved' && second === 'resolved' && net.pointerOk === submits && pending(map).length === 0, `${first} / ${second} ok=${net.pointerOk}`)
	}
	{ // another device moves the head between this device's head sync and its signature
		reset()
		const mine = new Map<string, unknown>(); const theirs = new Map<string, unknown>()
		await settle((await tab(mine)).append(entry('base', 1_700_000_303_000)))
		const other = await tab(theirs)
		const me = await tab(mine)
		net.onUpload = async () => { await settle(other.append(entry('theirs', 1_700_000_303_001))) }
		const r = await settle(me.append(entry('mine', 1_700_000_303_002)))
		check('the head moved during the upload: the stale index is NOT signed over it; the other device\'s record stays in the head; this one is not confirmed', r !== 'resolved' && (await headIds()) === 'base,theirs', `${r} head=${await headIds()}`)
		const retry = await settle(me.append(entry('mine', 1_700_000_303_002)))
		check('the retry merges and publishes both', retry === 'resolved' && (await headIds()) === 'base,mine,theirs', `${retry} head=${await headIds()}`)
	}
	{ // late writes: a tab that held an old index in memory appends after another tab wrote
		reset()
		const map = new Map<string, unknown>()
		const old = await tab(map)
		await settle(old.append(entry('o1', 1_700_000_304_000, 'out')))
		await settle((await tab(map)).append(entry('o2', 1_700_000_304_001, 'out')))
		await settle(old.append(entry('o3', 1_700_000_304_002, 'out')))
		check('a late write of a tab with an older index in memory loses nothing', (await headIds()) === 'o1,o2,o3', await headIds())
	}
	{ // concurrent OUTBOUND appends of three tabs with slow local index writes: the local index (what this device shows and publishes next) loses nothing, without any retry
		reset(); net.pointer = 'fail'
		const map = new Map<string, unknown>()
		const tabs = [await tab(map, { slow: slowFor(1, 60) }), await tab(map, { slow: slowFor(15, 0) }), await tab(map, { slow: slowFor(5, 30) })]
		await Promise.all(tabs.map((x, i) => settle(x.append(entry(`out${i}`, 1_700_000_305_000 + i, 'out')))))
		const reader = await tab(map) as unknown as { loadLocalManifest(): Promise<{ records: Array<{ sendId: string }> } | null> }
		const local = ((await reader.loadLocalManifest())?.records ?? []).map((r) => r.sendId).sort().join()
		check('three tabs writing at once: the local index on disk holds all three', local === 'out0,out1,out2', local)
	}
	{ // no lock, outbound: nothing is ever published by that path either
		reset()
		const map = new Map<string, unknown>()
		const r = await settle((await tab(map, { lock: false })).append(entry('out-nolock', 1_700_000_306_000, 'out')))
		check('without a lock an outbound mirror keeps its local copy and publishes NOTHING', r === 'resolved' && net.pointerOk === 0 && chain.hash === '' && [...map.keys()].some((k) => k.startsWith('beamio.chat.history.index:')), `${r} pointerOk=${net.pointerOk}`)
	}
	{ // a repeated append in the tab whose memory is OLDER than the local index: it must not write its old list over the other tab's record (an outbound record has no redelivery)
		reset(); net.pointer = 'fail'
		const map = new Map<string, unknown>()
		const older = await tab(map); const newer = await tab(map)
		await settle(older.append(entry('in-1', 1_700_000_307_000)))
		await settle(newer.append(entry('out-2', 1_700_000_307_001, 'out')))
		await settle(older.append(entry('in-1', 1_700_000_307_000))) // the duplicate path, which commits from memory unless the index is read again
		net.pointer = 'ok'
		const fresh = await tab(map)
		await settle(fresh.append(entry('in-1', 1_700_000_307_000)))
		await settle(fresh.append(entry('in-3', 1_700_000_307_002)))
		check('the other tab\'s outbound record is still in the local index and reaches the published head', (await headIds()).split(',').includes('out-2'), await headIds())
	}
	{ // a publication of the very index that is the head already (what a reused, sealed index makes possible): no second signature, and the writer builds on it afterwards
		reset()
		const map = new Map<string, unknown>()
		const t1 = await tab(map)
		await settle(t1.append(entry('k7', 1_700_000_308_000, 'out')))
		const published = chain.hash
		const other = await tab(map) as unknown as { updateOnchainPointer(h: string, m: unknown): Promise<boolean>; loadLocalManifest(): Promise<{ records: unknown[] }>; baseHead: string | null; headKeys: Set<string> }
		const manifest = await other.loadLocalManifest()
		const before = net.pointerOk
		const ok = await other.updateOnchainPointer(published, manifest)
		check('the head already is this index: success without a new pointer, and the base and the held keys are that index', ok && net.pointerOk === before && other.baseHead === published && other.headKeys.has('k7'), `ok=${ok} base=${other.baseHead} keys=${[...other.headKeys]}`)
	}
	console.log(`\n${passes} passed, ${failures} failed`)
	process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
