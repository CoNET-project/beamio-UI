/**
 * A page that ends (a normal close) while the history network work is still running: is the message on this device at the next start, in the library the page reads?
 * REAL HistoryStore.append and REAL LocalChatStore (in-memory backend); the network is the only double: fragment uploads never answer (a slow endpoint). Synthetic values. No browser.
 * Run: npx tsx scripts/testHistoryLocalFirst.ts
 */
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
async function process_(map: Map<string, unknown>, data: MemoryData, state: 'none' | 'running' | 'complete' | 'switched' | 'purged', lockOwner: object = {}) {
	const h = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined } as never,
		{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: persistenceOver(map) as never, accountLock: sharedLockFor(lockOwner as never) }, // a page that has ended releases its Web Lock: each process here has its own lock
	)
	await h.init()
	const lib = new LocalChatStore(async () => new MemoryBackend(data))
	const k = await keysPromise
	await lib.openWithKeys({ kId: k.kId.slice(), kIdx: k.kIdx.slice(), dek: k.dek.slice() })
	if ((await lib.getMigrationState()) !== state) await lib.setMigrationState(state)
	const priv = h as unknown as Record<string, unknown> & { manifest: { records: Array<{ sendId?: string }> } | null }
	priv.localKeys = { kId: k.kId.slice(), kIdx: k.kIdx.slice(), dek: k.dek.slice() } // the wallet layer has unlocked the library, as before any append of a page
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

const rowsFor = async (lib: LocalChatStore, sendId: string): Promise<number> => (await lib.openConversation(peer, VP)).items.filter((i) => (i.body ?? '').includes(`"sendId":"${sendId}"`)).length
const entry = (dir: 'in' | 'out', sendId: string, ts: number) => ({ peer, dir, ts, sendId, body: JSON.stringify({ sendId, text: `synthetic-${sendId}` }) })
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5)) }

async function main(): Promise<void> {
	for (const dir of ['out', 'in'] as const) {
		for (const state of ['purged', 'switched'] as const) {
			const map = new Map<string, unknown>(); const data = new MemoryData()
			const p1 = await process_(map, data, state)
			p1.priv.uploadFragment = () => new Promise<string>(() => undefined) // the endpoint does not answer
			let first = 'pending'; let second = 'pending'
			void p1.h.append(entry(dir, `a-${dir}`, 1_700_000_000_000)).then(() => { first = 'resolved' }, () => { first = 'rejected' })
			void p1.h.append(entry(dir, `b-${dir}`, 1_700_000_000_100)).then(() => { second = 'resolved' }, () => { second = 'rejected' }) // waits behind the first
			await settle()
			check(`${dir}/${state}: neither append is confirmed while the network has not answered (no mailbox ACK and no queue release can follow)`, first === 'pending' && second === 'pending', `${first},${second}`)
			// ---- the page ends here: nothing in memory survives ----
			const p2 = await process_(map, data, state)
			const a = await rowsFor(p2.lib, `a-${dir}`); const b = await rowsFor(p2.lib, `b-${dir}`)
			check(`${dir}/${state}: after the restart the library holds the message whose network work was running`, a === 1, `rows=${a}`)
			check(`${dir}/${state}: and the one that was waiting behind it`, b === 1, `rows=${b}`)
			// the repeat of the same message (the queue retry, or the mailbox redelivery) completes it without a second row
			await p2.h.append(entry(dir, `a-${dir}`, 1_700_000_000_000))
			await p2.h.append(entry(dir, `a-${dir}`, 1_700_000_000_000))
			await p2.h.loadLocalManifest()
			check(`${dir}/${state}: the repeat adds no second row and exactly one index record`, (await rowsFor(p2.lib, `a-${dir}`)) === 1 && p2.priv.manifest?.records.filter((r) => r.sendId === `a-${dir}`).length === 1)
		}
	}
	{
		// the early row is not a confirmation: a failing later step still rejects the append
		const map = new Map<string, unknown>(); const data = new MemoryData()
		const p1 = await process_(map, data, 'purged')
		p1.priv.updateOnchainPointer = async () => false
		let r = 'resolved'
		try { await p1.h.append(entry('in', 'c-in', 1_700_000_001_000)) } catch { r = 'rejected' }
		check('the early row confirms nothing: an inbound append whose pointer is refused still rejects', r === 'rejected')
		const text = JSON.stringify([...map.entries()])
		check('the early write adds no plaintext to the key-value store', !text.includes('synthetic-c-in'))
	}
	console.log(`history local first: ${passes} passed, ${failures} failed`)
	process.exit(failures ? 1 : 0)
}
void main()
