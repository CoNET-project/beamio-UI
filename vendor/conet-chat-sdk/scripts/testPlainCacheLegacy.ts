/**
 * Legacy plaintext history cache (`beamio.chat.history.plain:`), D1-D4 of PROPOSAL-plain-history-cache-nonlossy-fix-.
 *
 * D1 the cache is enabled only while the migration is none / running; complete, switched and purged turn it OFF (the old rule `state !== 'complete'` turned it back ON for switched and purged), and a
 *     (re)opened library does not turn it on again.
 * D2 a library account never answers from a plaintext key (the encrypted fragment is used); a legacy account still does.
 * D3 purgeLegacyPlain: every plaintext row is ingested into the library first, and NOTHING is deleted unless every row is proven there; the count after the delete must be 0.
 * D4 the keys(prefix) the worker persistence adds (key range only) and the background trigger after the library opens.
 *
 * Environment: Node ${process.version}; synthetic wallet and rows, in-memory persistence and in-memory library (no IndexedDB, no network).
 * Run: npx tsx scripts/testPlainCacheLegacy.ts
 */
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { sharedLockFor } from './fixtures/historyHarness.js'
import { HistoryStore, isKnownMigrationState, plainCacheEnabledFor } from '../src/worker/history.js'
import { hkdf, keccakUtf8, aesGcmEncryptString } from '../src/crypto.js'
import { deriveLocalKeys } from '../src/local/keys.js'
import { LocalChatStore } from '../src/local/store.js'
import { MemoryBackend, MemoryData } from '../src/local/backend.js'

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail?: string): void {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

const wallet = ethers.Wallet.createRandom()
const eoa = wallet.address.toLowerCase()
const PREFIX = `beamio.chat.history.plain:${eoa}:`
const peer = '0x' + '22'.repeat(20)

type Persist = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; keys?(p: string): Promise<string[]> }
function memoryPersistence(map: Map<string, unknown>, opts: { noKeys?: boolean; failGet?: Set<string>; failDelete?: Set<string> } = {}): Persist {
	const p: Persist = {
		get: async (k) => (opts.failGet?.has(k) ? undefined : map.get(k)),
		set: async (k, v) => void map.set(k, v),
		delete: async (k) => { if (!opts.failDelete?.has(k)) map.delete(k) },
	}
	if (!opts.noKeys) p.keys = async (prefix) => [...map.keys()].filter((k) => k >= prefix && k <= `${prefix}￿`)
	return p
}

const logged: Array<{ level: string; message: string }> = []
function makeHistory(persistence: Persist) {
	return new HistoryStore(
		{ buffer: () => undefined, log: (level: string, message: string) => void logged.push({ level, message }) } as never,
		{
			eoaAddress: wallet.address,
			signing: wallet as unknown as never,
			chainId: 8453,
			ipfsBaseUrl: 'https://ipfs.test',
			conetRpcUrl: 'https://rpc.test',
			chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001',
			apiBaseUrl: 'https://api.test',
			persistence: persistence as never,
			accountLock: sharedLockFor(persistence),
		},
	)
}

const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => {
	const entry = { seq: i, ts: 1_700_000_000_000 + i, peer, dir: (i % 2 ? 'out' : 'in') as 'in' | 'out', sendId: `${tag}-send-${i}`, body: JSON.stringify({ sendId: `${tag}-send-${i}`, from: i % 2 ? 'me' : 'them', text: `${tag} synthetic ${i}`, createdAt: 1_700_000_000_000 + i }) }
	return { cid: keccakUtf8(`${tag}-cid-${i}`), entry, searchText: `${tag} synthetic ${i}` }
})

/** A history store whose library is an in-memory open store in the given migration state (the IndexedDB backend is replaced). */
async function withLibrary(map: Map<string, unknown>, state: 'none' | 'running' | 'complete' | 'switched' | 'purged', opts: Parameters<typeof memoryPersistence>[1] = {}) {
	const h = makeHistory(memoryPersistence(map, opts))
	await h.init()
	const data = new MemoryData()
	const lib = new LocalChatStore(async () => new MemoryBackend(data))
	const keys = await deriveLocalKeys(await hkdf(new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff), 'test-rdb-v1', 32), eoa, 'ws')
	await lib.openWithKeys(keys)
	if (state !== 'none') await lib.setMigrationState(state)
	const priv = h as unknown as { localStore: LocalChatStore; localReady: Promise<LocalChatStore>; plainCacheEnabled: boolean; plainPurgeScheduled: boolean }
	priv.localStore = lib
	priv.localReady = Promise.resolve(lib)
	priv.plainPurgeScheduled = true // the background trigger is tested separately; here the purge is called directly
	return { h, lib, priv }
}

async function main(): Promise<void> {
	// D1 ----------------------------------------------------------------
	check('D1 plainCacheEnabledFor: none and running keep the legacy cache', plainCacheEnabledFor('none') && plainCacheEnabledFor('running'))
	check('D1 plainCacheEnabledFor: complete, switched and purged turn it OFF (the old rule turned switched and purged back ON)', !plainCacheEnabledFor('complete') && !plainCacheEnabledFor('switched') && !plainCacheEnabledFor('purged'))
	check('D1 plainCacheEnabledFor: an unknown state keeps the legacy behaviour', plainCacheEnabledFor('something_new') && plainCacheEnabledFor(null) && plainCacheEnabledFor(undefined))
	{
		const src = readFileSync(new URL('../src/worker/history.ts', import.meta.url), 'utf8')
		check('D1 ensureLocal uses plainCacheEnabledFor (not `state !== complete`)', /this\.plainCacheEnabled = plainCacheEnabledFor\(migration\)/.test(src) && !/plainCacheEnabled = \(await store\.getMigrationState\(\)\) !== 'complete'/.test(src))
	}
	{
		const map = new Map<string, unknown>()
		const { h, lib, priv } = await withLibrary(map, 'complete')
		priv.plainCacheEnabled = true
		check('D1 switchLocal turns the plaintext cache off', (await h.switchLocal()) === true && priv.plainCacheEnabled === false && (await lib.getMigrationState()) === 'switched')
	}
	{
		const map = new Map<string, unknown>()
		const { h, priv } = await withLibrary(map, 'switched')
		priv.plainCacheEnabled = false
		const r = rows(1, 'w')[0]
		await (h as unknown as { rememberPlain(c: string, e: unknown): Promise<void> }).rememberPlain(r.cid, r.entry)
		check('D1 a library account writes NO plaintext key', [...map.keys()].filter((k) => k.startsWith(PREFIX)).length === 0)
		priv.plainCacheEnabled = true
		await (h as unknown as { rememberPlain(c: string, e: unknown): Promise<void> }).rememberPlain(r.cid, r.entry)
		check('D1 a legacy account (cache enabled) still writes one', [...map.keys()].filter((k) => k.startsWith(PREFIX)).length === 1)
	}

	// D2 ----------------------------------------------------------------
	{
		const mat = async (h: HistoryStore, cid: string) => (h as unknown as { materializeRecord(r: unknown): Promise<{ entry: { body: string } | null }> }).materializeRecord({ cid, seq: 0, prevCid: '0x', ts: 1, peer, dir: 'in', sendId: 's' })
		const r = rows(1, 'm')[0]
		const mapOn = new Map<string, unknown>([[`${PREFIX}${r.cid}`, { entry: r.entry, searchText: r.searchText }]])
		const legacy = await withLibrary(mapOn, 'running')
		legacy.priv.plainCacheEnabled = true
		check('D2 a legacy account answers from the plaintext key', (await mat(legacy.h, r.cid)).entry?.body === r.entry.body)
		const mapOff = new Map<string, unknown>([[`${PREFIX}${r.cid}`, { entry: r.entry, searchText: r.searchText }]])
		const lib = await withLibrary(mapOff, 'switched')
		lib.priv.plainCacheEnabled = false
		// no plaintext read: it falls to the fragment (none here, and the network is not reachable) -> null, never the plaintext body
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
		const got = await mat(lib.h, r.cid)
		globalThis.fetch = realFetch
		check('D2 a library account never answers from a plaintext key', got.entry === null)
		// and the encrypted fragment answers when it is there
		const frag = await withLibrary(new Map<string, unknown>(), 'switched')
		frag.priv.plainCacheEnabled = false
		const priv = frag.h as unknown as { fragmentKey(seq: number, prev: string): Promise<Uint8Array> }
		const cipher = await aesGcmEncryptString(await priv.fragmentKey(7, '0xprev'), r.entry.body)
		await (frag.h as unknown as { opts: { persistence: Persist } }).opts.persistence.set(`beamio.chat.history.frag:${r.cid}`, cipher)
		const viaFrag = await (frag.h as unknown as { materializeRecord(r: unknown): Promise<{ entry: { body: string } | null }> }).materializeRecord({ cid: r.cid, seq: 7, prevCid: '0xprev', ts: 1, peer, dir: 'in', sendId: 's' })
		check('D2 the encrypted fragment answers for a library account (no plaintext needed)', viaFrag.entry?.body === r.entry.body)
	}

	// D3 ----------------------------------------------------------------
	const plainMap = (rs: ReturnType<typeof rows>, extra: Array<[string, unknown]> = []) => {
		const m = new Map<string, unknown>(extra)
		for (const r of rs) m.set(`${PREFIX}${r.cid}`, { entry: r.entry, searchText: r.searchText })
		return m
	}
	const keysLeft = (m: Map<string, unknown>) => [...m.keys()].filter((k) => k.startsWith(PREFIX)).length
	const libCount = async (lib: LocalChatStore) => (await lib.digestConversation(peer)).count
	{
		// (a) rows the library does not hold are backfilled, then every key is deleted, and other keys stay
		const other = [['beamio.chat.history.frag:keep', 'cipher'], ['beamio.chat.history.plain:0x' + '99'.repeat(20) + ':c1', { entry: rows(1, 'o')[0].entry, searchText: 'x' }], ['library:meta', 'm']] as Array<[string, unknown]>
		const map = plainMap(rows(5, 'a'), other)
		const { h, lib } = await withLibrary(map, 'switched')
		const r = await h.purgeLegacyPlain()
		check('D3a status purged, 5 keys, 5 rows, 5 inserted into the library, 5 removed, 0 left', r.status === 'purged' && r.keys === 5 && r.rows === 5 && r.inserted === 5 && r.removed === 5 && r.remaining === 0, JSON.stringify(r))
		check('D3a the library now holds all 5 (history is not lost)', (await libCount(lib)) === 5)
		check('D3a only this account\'s plaintext keys were deleted (other account, fragments, other keys stay)', keysLeft(map) === 0 && map.has('beamio.chat.history.frag:keep') && map.has('library:meta') && [...map.keys()].some((k) => k.includes('99'.repeat(20))))
		const again = await h.purgeLegacyPlain()
		check('D3a a second run finds nothing: clean', again.status === 'clean' && again.keys === 0)
	}
	{
		// (b) rows the library already holds: present, nothing inserted twice
		const rs = rows(4, 'b')
		const map = plainMap(rs)
		const { h, lib } = await withLibrary(map, 'purged') // a purged account with leftovers (the old switch bug)
		await h.purgeLegacyPlain()
		const first = await libCount(lib)
		for (const r of rs) map.set(`${PREFIX}${r.cid}`, { entry: r.entry, searchText: r.searchText })
		const r2 = await h.purgeLegacyPlain()
		check('D3b rows already in the library are `present`, not inserted again, and the count is unchanged', r2.status === 'purged' && r2.present === 4 && r2.inserted === 0 && (await libCount(lib)) === first && first === 4, JSON.stringify(r2))
	}
	{
		// (c) a locked library cannot say its state: the purge does not apply and deletes NOTHING; a library that refuses a row (conflict / locked at ingest) blocks it
		const map = plainMap(rows(3, 'c'))
		const { h, lib } = await withLibrary(map, 'switched')
		lib.lock()
		const r = await h.purgeLegacyPlain()
		check('D3c a locked library: the purge is skipped and deletes NOTHING', r.status === 'skipped' && r.removed === 0 && keysLeft(map) === 3, JSON.stringify(r))
		for (const outcome of ['conflict', 'locked']) {
			const m2 = plainMap(rows(3, `c${outcome}`))
			const lib2 = await withLibrary(m2, 'switched')
			;(lib2.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => outcome
			const r2 = await lib2.h.purgeLegacyPlain()
			check(`D3c an ingest outcome \`${outcome}\` blocks the purge and deletes NOTHING`, r2.status === 'blocked' && r2.reason === `ingest_${outcome}` && r2.removed === 0 && keysLeft(m2) === 3, JSON.stringify(r2))
		}
		const m3 = plainMap(rows(3, 'cthrow'))
		const lib3 = await withLibrary(m3, 'switched')
		;(lib3.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('x') }
		const r3 = await lib3.h.purgeLegacyPlain()
		check('D3c an ingest that throws blocks the purge and deletes NOTHING', r3.status === 'blocked' && r3.reason === 'ingest_threw' && keysLeft(m3) === 3, JSON.stringify(r3))
		const m4 = plainMap(rows(3, 'crb'))
		const lib4 = await withLibrary(m4, 'switched')
		;(lib4.lib as unknown as { verifyReadback: () => Promise<{ checked: number; failures: number }> }).verifyReadback = async () => ({ checked: 3, failures: 1 })
		const r4 = await lib4.h.purgeLegacyPlain()
		check('D3c a failing read-back of the library blocks the purge and deletes NOTHING', r4.status === 'blocked' && r4.reason === 'readback_failed' && keysLeft(m4) === 3, JSON.stringify(r4))
	}
	{
		// (d) a read that fails (the adapter answers undefined) blocks: a listed key with no value is a failed read, not an empty row
		const rs = rows(3, 'd')
		const map = plainMap(rs)
		const failGet = new Set([`${PREFIX}${rs[1].cid}`])
		const { h } = await withLibrary(map, 'switched', { failGet })
		const r = await h.purgeLegacyPlain()
		check('D3d a failed read blocks the purge and deletes NOTHING', r.status === 'blocked' && r.reason === 'read_failed' && r.removed === 0 && keysLeft(map) === 3, JSON.stringify(r))
	}
	{
		// (e) a delete that does not take: the recount says so, the keys left stay, no `purged`
		const rs = rows(3, 'e')
		const map = plainMap(rs)
		const failDelete = new Set([`${PREFIX}${rs[0].cid}`])
		const { h } = await withLibrary(map, 'switched', { failDelete })
		const r = await h.purgeLegacyPlain()
		check('D3e a delete that did not take is reported (failed, 1 left), never `purged`', r.status === 'failed' && r.reason === 'remaining' && r.remaining === 1 && keysLeft(map) === 1, JSON.stringify(r))
	}
	{
		// targeted read-back: every inserted row is ingested a second time and the library must answer `skipped`
		for (const second of ['conflict', 'inserted', 'locked']) {
			const m = plainMap(rows(3, `rb${second}`))
			const l = await withLibrary(m, 'switched')
			const real = l.lib.ingest.bind(l.lib)
			const seen = new Set<string>()
			;(l.lib as unknown as { ingest: (rec: { cid: string | null }) => Promise<string> }).ingest = async (rec) => {
				const first = !seen.has(String(rec.cid))
				seen.add(String(rec.cid))
				if (first) return real(rec as never)
				return second // the second ingest of the same row
			}
			const r = await l.h.purgeLegacyPlain()
			check(`D3c2 a second ingest that answers \`${second}\` (not skipped) blocks the purge: reason readback_${second}, NOTHING deleted`, r.status === 'blocked' && r.reason === `readback_${second}` && r.removed === 0 && keysLeft(m) === 3, JSON.stringify(r))
		}
		// the real library answers `skipped` the second time, so the normal purge goes through
		const ok = plainMap(rows(3, 'rbok'))
		const lok = await withLibrary(ok, 'switched')
		let calls = 0
		const realIngest = lok.lib.ingest.bind(lok.lib)
		;(lok.lib as unknown as { ingest: (rec: never) => Promise<string> }).ingest = async (rec) => { calls++; return realIngest(rec) }
		const rok = await lok.h.purgeLegacyPlain()
		check('D3c2 the real library answers skipped to the second ingest: purged, and every inserted row was ingested twice (3 rows, 6 calls)', rok.status === 'purged' && rok.inserted === 3 && calls === 6, JSON.stringify({ rok, calls }))
		const thr = plainMap(rows(2, 'rbthrow'))
		const lthr = await withLibrary(thr, 'switched')
		const realT = lthr.lib.ingest.bind(lthr.lib)
		let n = 0
		;(lthr.lib as unknown as { ingest: (rec: never) => Promise<string> }).ingest = async (rec) => { n++; if (n > 2) throw new Error('x'); return realT(rec) }
		const rthr = await lthr.h.purgeLegacyPlain()
		check('D3c2 a second ingest that throws blocks the purge: readback_threw, NOTHING deleted', rthr.status === 'blocked' && rthr.reason === 'readback_threw' && keysLeft(thr) === 2, JSON.stringify(rthr))
	}
	{
		// (f) not applicable: legacy states, no keys api
		const m1 = plainMap(rows(2, 'f'))
		const legacy = await withLibrary(m1, 'running')
		const r1 = await legacy.h.purgeLegacyPlain()
		check('D3f a legacy account (running) is skipped, its keys stay', r1.status === 'skipped' && keysLeft(m1) === 2, JSON.stringify(r1))
		const m2 = plainMap(rows(2, 'g'))
		const nokeys = await withLibrary(m2, 'switched', { noKeys: true })
		const r2 = await nokeys.h.purgeLegacyPlain()
		check('D3f a persistence without keys() is skipped (reason no_keys_api), nothing deleted', r2.status === 'skipped' && r2.reason === 'no_keys_api' && keysLeft(m2) === 2, JSON.stringify(r2))
	}
	{
		// (g) junk (a value that is not a plaintext row) holds no history: removed with the rest; the readable rows are still ingested first
		const rs = rows(2, 'h')
		const map = plainMap(rs, [[`${PREFIX}junk`, { not: 'a row' }]])
		const { h, lib } = await withLibrary(map, 'switched')
		const r = await h.purgeLegacyPlain()
		check('D3g junk keys are removed with the rest, readable rows are in the library first', r.status === 'purged' && r.junk === 1 && r.rows === 2 && (await libCount(lib)) === 2 && keysLeft(map) === 0, JSON.stringify(r))
	}
	{
		// (h) only counts leave: the result object has numbers and plain words
		const map = plainMap(rows(2, 'i'))
		const { h } = await withLibrary(map, 'switched')
		const r = await h.purgeLegacyPlain()
		const text = JSON.stringify(r)
		check('D3h the result carries only counts and status words (no body, no id, no key)', !text.includes('synthetic') && !text.includes('send-') && !text.includes('beamio.chat') && Object.values(r).every((v) => typeof v === 'number' || /^[a-z_0-9]*$/.test(String(v))), text)
	}

	// unknown migration state -----------------------------
	{
		check('state: isKnownMigrationState lists exactly none, running, complete, switched, purged', ['none', 'running', 'complete', 'switched', 'purged'].every(isKnownMigrationState) && !isKnownMigrationState('archived') && !isKnownMigrationState(null) && !isKnownMigrationState(undefined))
		const h = makeHistory(memoryPersistence(new Map()))
		const apply = (state: string | null) => (h as unknown as { applyMigrationState(s: string | null): void }).applyMigrationState(state)
		const priv = h as unknown as { plainCacheEnabled: boolean }
		logged.length = 0
		apply('archived_v2')
		check('state: an unknown non-null state keeps the cache ON and logs ONE warn naming only the state word', priv.plainCacheEnabled === true && logged.length === 1 && logged[0].level === 'warn' && /unknown migration state=archived_v2/.test(logged[0].message), JSON.stringify(logged))
		logged.length = 0
		apply('switched')
		apply('none')
		apply(null)
		check('state: known states and null log nothing', logged.length === 0 && priv.plainCacheEnabled === true)
		apply('purged')
		check('state: purged turns the cache off', priv.plainCacheEnabled === false)
	}

	// purgePlainKeys: the manifest keys go first, the rest goes through the D3 proof
	{
		const mk = async (map: Map<string, unknown>, rs: ReturnType<typeof rows>, opts: Parameters<typeof memoryPersistence>[1] = {}) => {
			const l = await withLibrary(map, 'switched', opts)
			;(l.h as unknown as { manifest: { records: Array<{ cid: string }> } | null }).manifest = { records: rs.map((r) => ({ cid: r.cid })) }
			;(l.h as unknown as { loadLocalManifest: () => Promise<void> }).loadLocalManifest = async () => undefined
			return l
		}
		// (a) rows outside the manifest are ingested into the library first, then everything is deleted, then purged
		const rs = rows(3, 'pk')
		const outside = rows(2, 'pkextra')
		const map = plainMap([...rs, ...outside], [['beamio.chat.history.frag:keep', 'cipher']])
		const a = await mk(map, rs)
		const removed = await a.h.purgePlainKeys()
		check('purgePlainKeys: the 3 manifest keys and the 2 outside keys are all gone (5 removed), the 2 outside rows were backfilled into the library first, state purged, other keys stay', removed === 5 && keysLeft(map) === 0 && (await libCount(a.lib)) === 2 && (await a.lib.getMigrationState()) === 'purged' && map.has('beamio.chat.history.frag:keep'), String(removed))
		// (b) the proof blocks (a conflict at ingest): the outside keys are NOT deleted, the state stays switched, the call throws
		const rs2 = rows(2, 'pkb')
		const out2 = rows(2, 'pkbextra')
		const map2 = plainMap([...rs2, ...out2])
		const b = await mk(map2, rs2)
		;(b.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => 'conflict'
		let threw = ''
		try { await b.h.purgePlainKeys() } catch (e) { threw = String((e as Error).message) }
		check('purgePlainKeys: a blocked sweep throws, keeps the state switched and deletes NO outside key (the manifest keys were already removed)', /purge plain keys not complete: blocked_ingest_conflict/.test(threw) && (await b.lib.getMigrationState()) === 'switched' && keysLeft(map2) === 2 && out2.every((r) => map2.has(`${PREFIX}${r.cid}`)), threw)
		// (c) a delete that does not take: failed, state switched
		const rs3 = rows(1, 'pkc')
		const out3 = rows(2, 'pkcextra')
		const map3 = plainMap([...rs3, ...out3])
		const c = await mk(map3, rs3, { failDelete: new Set([`${PREFIX}${out3[0].cid}`]) })
		let threw3 = ''
		try { await c.h.purgePlainKeys() } catch (e) { threw3 = String((e as Error).message) }
		check('purgePlainKeys: a delete that did not take throws (failed_remaining) and keeps the state switched', /failed_remaining/.test(threw3) && (await c.lib.getMigrationState()) === 'switched', threw3)
		// (d) nothing outside the manifest: clean, purged
		const rs4 = rows(2, 'pkd')
		const map4 = plainMap(rs4)
		const d = await mk(map4, rs4)
		check('purgePlainKeys: no key outside the manifest: purged (2 removed)', (await d.h.purgePlainKeys()) === 2 && (await d.lib.getMigrationState()) === 'purged')
		// (e) a persistence that cannot list keys: the manifest keys are gone and there is nothing more to sweep: purged (as before)
		const rs5 = rows(2, 'pke')
		const map5 = plainMap(rs5)
		const e5 = await mk(map5, rs5, { noKeys: true })
		check('purgePlainKeys: a persistence without keys() still ends purged (the sweep is skipped: no_keys_api)', (await e5.h.purgePlainKeys()) === 2 && (await e5.lib.getMigrationState()) === 'purged')
		// (f) not switched: refused as before
		const f6 = await withLibrary(plainMap(rows(1, 'pkf')), 'complete')
		let threw6 = ''
		try { await f6.h.purgePlainKeys() } catch (e) { threw6 = String((e as Error).message) }
		check('purgePlainKeys: still refused unless the state is switched', /requires migration state switched/.test(threw6), threw6)
	}

	// the FIRST append of a worker session must not write a plaintext key into a library account ----------------------------
	{
		type AppendPriv = { plainCacheEnabled: boolean; manifest: unknown; ensureLocal: () => Promise<unknown>; uploadFragment: () => Promise<string | null>; persistManifest: () => Promise<boolean>; syncFromHeadUnlocked: () => Promise<boolean>; ingestLocalAppend: () => Promise<boolean>; fragmentKey: () => Promise<Uint8Array> }
		const mkAppend = async (state: 'switched' | 'running', ensure: 'ok' | 'throws') => {
			const map = new Map<string, unknown>()
			const l = await withLibrary(map, state)
			const priv = l.h as unknown as AppendPriv
			priv.plainCacheEnabled = true // the worker-start default, before the library state is read
			priv.manifest = { v: 1, eoa, updatedAt: 0, records: [] }
			let opened = false
			// the library opens lazily, like the real ensureLocal: it applies the migration state when it opens
			priv.ensureLocal = async () => {
				if (ensure === 'throws') throw new Error('locked')
				if (!opened) { opened = true; priv.plainCacheEnabled = state === 'running' }
				return l.lib
			}
			priv.uploadFragment = async () => keccakUtf8('frag')
			priv.persistManifest = async () => true
			priv.updateOnchainPointer = async () => true // an inbound append needs its remote commit (pointer) too; the network is the one thing stubbed
			priv.syncFromHeadUnlocked = async () => false
			priv.ingestLocalAppend = async () => true
			priv.fragmentKey = async () => new Uint8Array(32).fill(7)
			return { map, h: l.h }
		}
		const plainKeys = (map: Map<string, unknown>) => [...map.keys()].filter((k) => k.startsWith(PREFIX)).length
		const sw = await mkAppend('switched', 'ok')
		await sw.h.append({ peer, dir: 'in', ts: 1_700_000_100_000, sendId: 'first-append-1', body: JSON.stringify({ sendId: 'first-append-1', text: 'synthetic' }) })
		check('D2 missed path: the FIRST append of a worker session writes NO plaintext key when the library state is switched', plainKeys(sw.map) === 0)
		const legacy = await mkAppend('running', 'ok')
		await legacy.h.append({ peer, dir: 'in', ts: 1_700_000_100_001, sendId: 'first-append-2', body: JSON.stringify({ sendId: 'first-append-2', text: 'synthetic' }) })
		check('D2 missed path: a legacy account (running) still writes its plaintext key on the first append', plainKeys(legacy.map) === 1)
		const locked = await mkAppend('switched', 'throws')
		await locked.h.append({ peer, dir: 'in', ts: 1_700_000_100_002, sendId: 'first-append-3', body: JSON.stringify({ sendId: 'first-append-3', text: 'synthetic' }) })
		check('D2 missed path: a library that cannot open does not fail the append (the cache keeps its default, as before)', plainKeys(locked.map) === 1)
		// retry and redelivery dedupe by sendId
		{
			const d = await mkAppend('switched', 'ok')
			const priv = d.h as unknown as AppendPriv & { manifest: { records: Array<{ sendId?: string }> } }
			let uploads = 0
			priv.uploadFragment = async () => { uploads += 1; return keccakUtf8('frag') }
			let ingests = 0
			priv.ingestLocalAppend = async () => { ingests += 1; return true }
			const e = { peer, dir: 'in' as const, ts: 1_700_000_200_000, sendId: 'redeliver-1', body: JSON.stringify({ sendId: 'redeliver-1', text: 'synthetic' }) }
			await d.h.append(e)
			await d.h.append(e) // the page's retry of the same append
			await d.h.append({ ...e, ts: e.ts + 5 }) // the mailbox redelivery of the same message (same sendId, anything else may differ)
			check('append dedupe: the same sendId three times (retry, redelivery) is ONE index record and ONE remote commit (remote commit: its fragment and the index, 2 uploads, once); the library row is ensured once (one ingest for the new record, none more after it)', priv.manifest.records.filter((r) => r.sendId === 'redeliver-1').length === 1 && uploads === 2 && ingests === 1, `records=${priv.manifest.records.length} uploads=${uploads} ingests=${ingests}`)
			await d.h.append({ ...e, sendId: 'redeliver-2' })
			check('append dedupe: a different sendId is a new record', priv.manifest.records.length === 2 && uploads === 4 && ingests === 2)
			// the half-way append: the record is in the index (manifest written, fragment uploaded) and the library ingest never ran (killed / failed in between)
			const hw = await mkAppend('switched', 'ok')
			const hwPriv = hw.h as unknown as AppendPriv & { manifest: { records: Array<{ sendId?: string }> } }
			let hwIngests = 0
			let killFirst = true
			hwPriv.ingestLocalAppend = async () => { hwIngests += 1; if (killFirst) { killFirst = false; throw new Error("killed between the manifest write and the library ingest") } return true }
			let hwUploads = 0
			hwPriv.uploadFragment = async () => { hwUploads += 1; return keccakUtf8('frag') }
			const he = { peer, dir: 'in' as const, ts: 1_700_000_300_000, sendId: 'halfway-1', body: JSON.stringify({ sendId: 'halfway-1', text: 'synthetic' }) }
			let first = 'resolved'
			try { await hw.h.append(he) } catch { first = 'rejected' }
			check('half-way append: the append that was cut short does NOT resolve (so no mailbox ACK follows it), while the record is already in the index', first === 'rejected' && hwPriv.manifest.records.length === 1 && hwIngests === 1)
			await hw.h.append(he) // the retry / the redelivery
			check('half-way append: the retry finds the sendId, adds NO second record and NO second remote commit, and completes the library row (a second ingest)', hwPriv.manifest.records.length === 1 && hwUploads === 2 && hwIngests === 2, `records=${hwPriv.manifest.records.length} uploads=${hwUploads} ingests=${hwIngests}`)
			await hw.h.append(he)
			check('half-way append: once the row is ensured the same sendId costs no more ingest (bounded memo)', hwIngests === 2)
		}
		{
			const src = readFileSync(new URL('../src/worker/history.ts', import.meta.url), 'utf8')
			const body = src.slice(src.indexOf('async append(entry'), src.indexOf('// ---- Local library'))
			check('D2 missed path: in append, ensureLocal is awaited BEFORE rememberPlain', body.indexOf('await this.ensureLocal().catch') > 0 && body.indexOf('await this.ensureLocal().catch') < body.indexOf('await this.rememberPlain('))
		}
	}

	// D4 ----------------------------------------------------------------
	{
		const entry = readFileSync(new URL('../src/worker/entry.ts', import.meta.url), 'utf8')
		check('D4 the worker persistence lists keys by key range only (no value read, no write)', /async keys\(prefix: string\) \{\s*const all = await tx<IDBValidKey\[\]>\('readonly', \(s\) => s\.getAllKeys\(IDBKeyRange\.bound\(prefix, `\$\{prefix\}\\uffff`\)\)\)/.test(entry))
		const src = readFileSync(new URL('../src/worker/history.ts', import.meta.url), 'utf8')
		check('D4 the purge is scheduled once after the library opens, only for switched / purged, and in the background', /!this\.plainPurgeScheduled && \(migration === 'switched' \|\| migration === 'purged'\)/.test(src) && /setTimeout\(\(\) => \{\s*void this\.purgeLegacyPlain\(\)/.test(src))
	}

	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures > 0) process.exit(1)
}

void main().catch((ex) => {
	console.error(ex)
	process.exit(1)
})
