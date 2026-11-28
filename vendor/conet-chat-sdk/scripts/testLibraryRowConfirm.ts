/**
 * "index appended, library row write failed, mailbox ACKed, process killed" - what is durable, what can be rebuilt, and when the append may say "confirmed".
 *
 * Facts established here with the REAL HistoryStore.append / persistManifest / syncLocal and the REAL LocalChatStore (in-memory backend; synthetic wallet and rows; network calls stubbed):
 *  R0 recovery path: the index (local manifest + local fragment cache) holds the message, the library lacks the row, the library says syncComplete=1 -> a library page shows no row and olderState 'end', so the page's
 *      one-time syncLocal trigger (olderState 'pending', services/chatLocalSyncOnce.ts) NEVER fires after a restart; only an explicit syncLocal rebuilds the row (once, idempotent).
 *      => if the mailbox ACK is sent while the library row is missing, nothing brings the message back by itself. That is the gap.
 *  G1 fix: for a library account (migration state switched / purged) `append` resolves only when the library row is confirmed written; a failed or locked library write REJECTS it (so no mailbox ACK follows), also on the
 *      duplicate-sendId path. A legacy account (none / running / complete) keeps the old best-effort behaviour.
 * Run: npx tsx scripts/testLibraryRowConfirm.ts
 */
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { sharedLockFor } from './fixtures/historyHarness.js'
import { HistoryStore } from '../src/worker/history.js'
import { hkdf, keccakUtf8 } from '../src/crypto.js'
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

type Persist = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; keys?(p: string): Promise<string[]> }
const persistenceOver = (map: Map<string, unknown>): Persist => ({
	get: async (k) => map.get(k),
	set: async (k, v) => void map.set(k, v),
	delete: async (k) => void map.delete(k),
	keys: async (prefix) => [...map.keys()].filter((k) => k >= prefix && k <= `${prefix}￿`),
})

const keysPromise = (async () => deriveLocalKeys(await hkdf(new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff), 'test-rdb-v1', 32), eoa, 'ws'))()

/** one worker process over the shared durable stores (persistence map = the worker's IndexedDB, data = the library database) */
async function process_(map: Map<string, unknown>, data: MemoryData, state: 'none' | 'running' | 'complete' | 'switched' | 'purged') {
	const h = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined } as never,
		{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: persistenceOver(map) as never, accountLock: sharedLockFor(map) },
	)
	await h.init()
	const lib = new LocalChatStore(async () => new MemoryBackend(data))
	const k = await keysPromise
	await lib.openWithKeys({ kId: k.kId.slice(), kIdx: k.kIdx.slice(), dek: k.dek.slice() })
	if ((await lib.getMigrationState()) !== state) await lib.setMigrationState(state)
	const priv = h as unknown as Record<string, unknown> & { manifest: { records: Array<{ sendId?: string }> } | null }
	priv.localStore = lib
	priv.localReady = Promise.resolve(lib)
	priv.plainPurgeScheduled = true
	priv.coldReconcileScheduled = true // the cold-start check is exercised on its own below; the other cases must not trigger it by themselves
	// the network is the one thing stubbed: fragments are "uploaded" (the local cipher cache is written by append itself), the pointer relay answers ok, the chain head is not read
	priv.uploadFragment = async (c: string) => keccakUtf8(c)
	priv.updateOnchainPointer = async () => true
	priv.syncFromHeadUnlocked = async () => false
	// the worker start reads the migration state when it opens the library: model it
	;(priv.applyMigrationState as (m: string) => void).call(h, state)
	return { h, lib, priv }
}

const bodyOf = (sendId: string, text: string): string => JSON.stringify({ sendId, text })
const entryOf = (sendId: string, ts: number) => ({ peer, dir: 'in' as const, ts, sendId, body: bodyOf(sendId, `synthetic-${sendId}`) })
const rowsFor = async (lib: LocalChatStore, sendId: string): Promise<{ n: number; olderState: string }> => {
	const page = await lib.openConversation(peer, VP)
	return { n: page.items.filter((i) => (i.body ?? '').includes(`"sendId":"${sendId}"`)).length, olderState: page.olderState }
}

async function main(): Promise<void> {
	// ---------------- the recovery facts (hold before and after the fix) ----------------
	{
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'switched')
		await p1.h.append(entryOf('base-1', 1_700_000_000_000)) // a healthy earlier message, so the library has a row and a finished sync
		await p1.lib.setSyncComplete(true)
		;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
		let threw = false
		try { await p1.h.append(entryOf('lost-1', 1_700_000_000_100)) } catch { threw = true }
		// ---- the process is killed here (nothing in memory survives; the persistence map and the library database do) ----
		const p2 = await process_(map, data, 'switched')
		await p2.h.loadLocalManifest()
		check('recovery: the index record survived the kill (local manifest + local fragment cache are durable)', p2.priv.manifest?.records.some((r) => r.sendId === 'lost-1') === true && p2.priv.manifest?.records.length === 2, `threw=${threw}`)
		const before = await rowsFor(p2.lib, 'lost-1')
		check('recovery: after the restart the library page has NO row for it and says olderState end: the page\'s one-time syncLocal trigger (olderState pending) would never fire', before.n === 0 && before.olderState === 'end', `rows=${before.n} older=${before.olderState}`)
		await p2.h.syncLocal() // an explicit sync is what rebuilds it
		const after = await rowsFor(p2.lib, 'lost-1')
		check('recovery: an explicit syncLocal rebuilds the row from the index and the local fragment, exactly once', after.n === 1, `rows=${after.n}`)
		await p2.h.syncLocal()
		check('recovery: a second syncLocal adds no second row (idempotent)', (await rowsFor(p2.lib, 'lost-1')).n === 1)
	}

	// ---------------- G1: append resolves only when the library row is confirmed (library account) ----------------
	{
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'switched')
		const realIngest = p1.lib.ingest.bind(p1.lib)
		let fail = true
		;(p1.lib as unknown as { ingest: (r: never) => Promise<string> }).ingest = async (r: never) => { if (fail) throw new Error('library write failed (synthetic)'); return realIngest(r) }
		let result = 'resolved'
		try { await p1.h.append(entryOf('g1-a', 1_700_000_001_000)) } catch { result = 'rejected' }
		check('G1 a library account: the library row write fails -> append REJECTS (so no mailbox ACK follows)', result === 'rejected')
		check('G1 ... while the record is already in the index (durable) and the library has no row yet', p1.priv.manifest?.records.some((r) => r.sendId === 'g1-a') === true && (await rowsFor(p1.lib, 'g1-a')).n === 0)
		fail = false
		let retry = 'rejected'
		try { await p1.h.append(entryOf('g1-a', 1_700_000_001_000)); retry = 'resolved' } catch { /* stays rejected */ }
		check('G1 the retry (the page back-off, or the mailbox redelivery) finds the sendId, adds no second index record, completes the library row and resolves', retry === 'resolved' && p1.priv.manifest?.records.filter((r) => r.sendId === 'g1-a').length === 1 && (await rowsFor(p1.lib, 'g1-a')).n === 1)
		await p1.h.append(entryOf('g1-a', 1_700_000_001_000))
		check('G1 a further duplicate stays one row', (await rowsFor(p1.lib, 'g1-a')).n === 1)
	}
	{
		// the write keeps failing on the duplicate path too: every retry rejects, nothing is remembered as done, the first healthy write completes the row
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'switched')
		const realIngest = p1.lib.ingest.bind(p1.lib)
		let failsLeft = 3
		;(p1.lib as unknown as { ingest: (r: never) => Promise<string> }).ingest = async (r: never) => { if (failsLeft-- > 0) throw new Error('library write failed (synthetic)'); return realIngest(r) }
		const outcomes: string[] = []
		for (let i = 0; i < 4; i++) {
			try { await p1.h.append(entryOf('g1-r', 1_700_000_008_000)); outcomes.push('resolved') } catch { outcomes.push('rejected') }
		}
		check('G1 three failed writes in a row (the first on the new-record path, two on the duplicate path) all reject; the fourth attempt completes the row and resolves', outcomes.join(',') === 'rejected,rejected,rejected,resolved' && (await rowsFor(p1.lib, 'g1-r')).n === 1 && p1.priv.manifest?.records.filter((r) => r.sendId === 'g1-r').length === 1, outcomes.join(','))
	}
	{
		// kill between the failed write and the retry: the restarted worker + the redelivery complete it
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'purged')
		;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
		let r1 = 'resolved'
		try { await p1.h.append(entryOf('g1-b', 1_700_000_002_000)) } catch { r1 = 'rejected' }
		const p2 = await process_(map, data, 'purged') // killed, restarted; the mailbox redelivers the un-ACKed line
		await p2.h.loadLocalManifest()
		let r2 = 'rejected'
		try { await p2.h.append(entryOf('g1-b', 1_700_000_002_000)); r2 = 'resolved' } catch { /* */ }
		check('G1 purged state, kill after the failed write, redelivery to the restarted worker: rejected first, then resolved with exactly one row and one index record', r1 === 'rejected' && r2 === 'resolved' && (await rowsFor(p2.lib, 'g1-b')).n === 1 && p2.priv.manifest?.records.filter((r) => r.sendId === 'g1-b').length === 1)
	}
	{
		// a locked / unreadable library outcome is not a confirmation either
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'switched')
		;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => 'locked'
		let r = 'resolved'
		try { await p1.h.append(entryOf('g1-c', 1_700_000_003_000)) } catch { r = 'rejected' }
		check('G1 an ingest outcome "locked" is not a confirmation: append rejects', r === 'rejected')
	}
	{
		// the confirmed outcomes: inserted (new), skipped (the row is already there), and a tombstone stays terminal
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'switched')
		let r = 'rejected'
		try { await p1.h.append(entryOf('g1-d', 1_700_000_004_000)); r = 'resolved' } catch { /* */ }
		check('G1 a healthy library write resolves (outcome inserted)', r === 'resolved' && (await rowsFor(p1.lib, 'g1-d')).n === 1)
	}

	{
		// the library cannot open in this worker session (keys not delivered yet, locked): what an earlier session learned still decides
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const first = await process_(map, data, 'switched') // an earlier session read the library: switched -> the authority is remembered durably
		await new Promise((r) => setTimeout(r, 5))
		check('G1 the library authority is remembered durably when the library state is read (switched)', map.get(`beamio.chat.history.libauth:${eoa}`) === '1')
		void first
		const second = await process_(map, data, 'switched')
		const p2 = second.priv as unknown as { ensureLocal: () => Promise<never>; libraryAuthoritative: boolean; localStore: unknown }
		p2.libraryAuthoritative = false // a fresh worker session: nothing read yet
		p2.localStore = null
		p2.ensureLocal = async () => { throw new Error('locked') } // the library cannot be opened now
		let r = 'resolved'
		try { await second.h.append(entryOf('g1-e', 1_700_000_006_000)) } catch { r = 'rejected' }
		check('G1 the library cannot open now but was a library account before: append REJECTS (index record written, no row, no ACK)', r === 'rejected' && second.priv.manifest?.records.some((x) => x.sendId === 'g1-e') === true)
		// no durable knowledge (a legacy device, or never read): the old best-effort behaviour
		const map2 = new Map<string, unknown>(); const data2 = new MemoryData()
		const third = await process_(map2, data2, 'running')
		const p3 = third.priv as unknown as { ensureLocal: () => Promise<never>; libraryAuthoritative: boolean }
		p3.ensureLocal = async () => { throw new Error('locked') }
		let r3 = 'rejected'
		try { await third.h.append(entryOf('g1-f', 1_700_000_007_000)); r3 = 'resolved' } catch { /* */ }
		check('G1 the library cannot open and nothing says it is the page\'s source (legacy / unknown): append keeps the old behaviour and resolves', r3 === 'resolved' && map2.get(`beamio.chat.history.libauth:${eoa}`) !== '1')
		// leaving library mode (local data deleted -> state none) clears the remembered authority
		const fourth = await process_(map, data, 'switched')
		;(fourth.priv.applyMigrationState as (m: string | null) => void).call(fourth.h, null)
		await new Promise((x) => setTimeout(x, 5))
		check('G1 an unknown migration read (null) does not clear the remembered authority', map.get(`beamio.chat.history.libauth:${eoa}`) === '1')
		;(fourth.priv.applyMigrationState as (m: string) => void).call(fourth.h, 'none')
		await new Promise((x) => setTimeout(x, 5))
		check('G1 a migration state of none (local data deleted) clears the remembered authority', map.get(`beamio.chat.history.libauth:${eoa}`) === '0')
	}

	// ---------------- cold start, library has fewer rows than the index has records -> one syncLocal, no explicit call ----------------
	{
		type ColdPriv = { coldReconcileScheduled: boolean; coldReconcileDone: Promise<void> | null; scheduleColdReconcile: (m: string | null) => void }
		const runCold = async (px: Awaited<ReturnType<typeof process_>>, state: string | null): Promise<number> => {
			const c = px.priv as unknown as ColdPriv & { syncLocal: () => Promise<void> }
			let syncs = 0
			const realSync = c.syncLocal.bind(px.h)
			c.syncLocal = async () => { syncs += 1; return realSync() }
			c.coldReconcileScheduled = false
			c.coldReconcileDone = null
			c.scheduleColdReconcile(state)
			if (c.coldReconcileDone) await c.coldReconcileDone
			return syncs
		}
		{
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p1 = await process_(map, data, 'switched')
			await p1.h.append(entryOf('c1-base', 1_700_000_010_000))
			await p1.lib.setSyncComplete(true)
			;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
			try { await p1.h.append(entryOf('c1-lost', 1_700_000_010_100)) } catch { /* rejected: no ACK */ }
			// ---- killed; a cold start: the library has 1 row, the index 2 records ----
			const p2 = await process_(map, data, 'switched')
			await p2.h.loadLocalManifest()
			const before = await rowsFor(p2.lib, 'c1-lost')
			check('C1 before the cold-start check: the library page has no row and says olderState end (the page trigger would not fire)', before.n === 0 && before.olderState === 'end', JSON.stringify(before))
			check('C1 the library counts fewer rows than the index has records', (await p2.lib.countRows()) === 1 && (p2.priv.manifest?.records.length ?? 0) === 2)
			const syncs = await runCold(p2, 'switched')
			check('C1 the cold-start check ran ONE syncLocal and the lost row is back, once, with no explicit syncLocal from the page', syncs === 1 && (await rowsFor(p2.lib, 'c1-lost')).n === 1 && (await p2.lib.countRows()) === 2, `syncs=${syncs}`)
			const again = await runCold(p2, 'switched')
			check('C1 a second cold-start check in a session where the library is in step runs NO sync', again === 0)
			p2.priv.coldReconcileScheduled = true
			;(p2.priv as unknown as ColdPriv).scheduleColdReconcile('switched')
			const syncsAfterOnce = await runCold(await process_(map, data, 'switched'), 'switched')
			check('C1 a fresh worker session over a library in step does not sync either (counts only)', syncsAfterOnce === 0)
		}
		{
			// once per worker session: a repeated schedule call does nothing, even if the library is still behind
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p1 = await process_(map, data, 'purged')
			;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
			try { await p1.h.append(entryOf('c1-once', 1_700_000_011_000)) } catch { /* */ }
			const p2 = await process_(map, data, 'purged')
			await p2.h.loadLocalManifest()
			const c = p2.priv as unknown as ColdPriv & { syncLocal: () => Promise<void> }
			let syncs = 0
			c.syncLocal = async () => { syncs += 1; throw new Error('sync failed (synthetic)') }
			c.coldReconcileScheduled = false
			c.scheduleColdReconcile('purged')
			c.scheduleColdReconcile('purged')
			c.scheduleColdReconcile('purged')
			if (c.coldReconcileDone) await c.coldReconcileDone
			check('C1 once per worker session, and a failing sync neither throws out of the check nor is retried in a loop', syncs === 1)
		}
		for (const state of ['none', 'running', 'complete', null] as const) {
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p1 = await process_(map, data, state ?? 'none')
			await p1.h.append(entryOf(`c1-leg-${state}`, 1_700_000_012_000))
			;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
			await p1.h.append(entryOf(`c1-leg2-${state}`, 1_700_000_012_100))
			const syncs = await runCold(p1, state)
			check(`C1 legacy / unknown migration state (${state}): no cold-start sync`, syncs === 0)
		}
		{
			// the library cannot count (locked): say nothing, run nothing
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p1 = await process_(map, data, 'switched')
			;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
			try { await p1.h.append(entryOf('c1-lock', 1_700_000_013_000)) } catch { /* */ }
			;(p1.lib as unknown as { countRows: () => Promise<number> }).countRows = async () => -1
			check('C1 a library that cannot count (-1) triggers no sync', (await runCold(p1, 'switched')) === 0)
		}
		{
			// the REAL library open (ensureLocal over IndexedDB; fake-indexeddb in node): a library that was left one row behind is brought in step by the cold start itself, with no call from the page.
			// This also runs the real IdbBackend.countRows.
			await import('fake-indexeddb/auto')
			const map = new Map<string, unknown>()
			const real = async () => {
				const h = new HistoryStore(
					{ buffer: () => undefined, log: () => undefined } as never,
					{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: persistenceOver(map) as never, accountLock: sharedLockFor(map) },
				)
				await h.init()
				const priv = h as unknown as Record<string, unknown> & { manifest: { records: Array<{ sendId?: string }> } | null; localStore: LocalChatStore | null; coldReconcileDone: Promise<void> | null; ensureLocal: () => Promise<LocalChatStore> }
				const k = await keysPromise
				priv.localKeys = { kId: k.kId.slice(), kIdx: k.kIdx.slice(), dek: k.dek.slice() }
				priv.plainPurgeScheduled = true
				priv.uploadFragment = async (c: string) => keccakUtf8(c)
				priv.updateOnchainPointer = async () => true
				priv.syncFromHeadUnlocked = async () => false
				return { h, priv }
			}
			// session 1: the library is opened for real, made a library account, one message saved, a second one's row write fails (append rejects: no ACK)
			const s1 = await real()
			const lib1 = await s1.priv.ensureLocal()
			await lib1.setMigrationState('switched')
			;(s1.priv.applyMigrationState as (m: string) => void).call(s1.h, 'switched')
			await s1.h.append(entryOf('c2-base', 1_700_000_020_000))
			await lib1.setSyncComplete(true)
			;(lib1 as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
			let rej = false
			try { await s1.h.append(entryOf('c2-lost', 1_700_000_020_100)) } catch { rej = true }
			check('C2 (real IndexedDB library) the second append was rejected: index record written, library row missing', rej && (await lib1.countRows()) === 1)
			s1.priv.localStore?.close?.()
			// ---- killed; session 2 is a cold start: nothing is preset, the library is opened by the worker's own ensureLocal ----
			const s2 = await real()
			await s2.h.loadLocalManifest()
			await s2.priv.ensureLocal() // the cold start's library open: this alone must schedule and run the check
			check('C2 the cold start scheduled the check by itself', s2.priv.coldReconcileDone !== null)
			if (s2.priv.coldReconcileDone) await s2.priv.coldReconcileDone
			const lib2 = s2.priv.localStore as LocalChatStore
			const page = await lib2.openConversation(peer, VP)
			const n = page.items.filter((i) => (i.body ?? '').includes('"sendId":"c2-lost"')).length
			check('C2 after the cold start the lost row is in the real library, once, and the library counts as many rows as the index has records', n === 1 && (await lib2.countRows()) === 2, `n=${n}`)
		}
		{
			// the check is wired into the library open (ensureLocal), not only callable
			const src = readFileSync(new URL('../src/worker/history.ts', import.meta.url), 'utf8')
			const open = src.slice(src.indexOf('private async ensureLocal()'), src.indexOf('Fetch and decrypt one manifest record'))
			check('C1 ensureLocal (the library open) calls scheduleColdReconcile with the migration state it just read', /this\.applyMigrationState\(migration\)[\s\S]*this\.localStore = store[\s\S]*this\.scheduleColdReconcile\(migration\)/.test(open))
		}
	}

	// ---------------- legacy accounts keep the old best-effort behaviour ----------------
	for (const state of ['none', 'running', 'complete'] as const) {
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, state)
		;(p1.lib as unknown as { ingest: () => Promise<string> }).ingest = async () => { throw new Error('library write failed (synthetic)') }
		let r = 'rejected'
		try { await p1.h.append(entryOf(`leg-${state}`, 1_700_000_005_000)); r = 'resolved' } catch { /* */ }
		check(`legacy account (migration ${state}): a library write failure does NOT fail the append (the library is not what the page reads)`, r === 'resolved')
	}

	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures > 0) process.exit(1)
}

void main().catch((ex) => {
	console.error(ex)
	process.exit(1)
})
