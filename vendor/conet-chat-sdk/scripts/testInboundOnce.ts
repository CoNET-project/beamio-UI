/**
 * The recipient's side of a send that is repeated: the same sendId and the same payload arrive again and again, with the page ended in between (also while the first copy is still being saved).
 * How often does the recipient RECORD it? Real: the sender's send queue, queue store and armor context (src/services/sendQueue.ts), the recipient's row merge (src/services/chatMessageMerge.ts), the history
 * HistoryStore.append, the encrypted library. Doubles: the mailbox (it hands over the armor of every POST), the network of the history, the databases (in memory). Level: code, one process; no browser,
 * no node, and the page's own line routing (App.tsx) is not run.
 * Run: npx tsx scripts/testInboundOnce.ts
 */
import { createQueueStore, createSendQueue, type QueueDocAdapter } from '../../../src/services/sendQueue.js'
import { base64JsonCodec } from '../../../src/services/chatDraftStore.js'
import { makeMessage } from '../../../src/services/chatMessageMerge.js'
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

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5)) }
type Row = { sendId?: string; from: string; createdAt?: number }

async function main(): Promise<void> {
	const SENDER = '0x' + 'aa'.repeat(20)
	const docs = new Map<string, string>()
	const doc: QueueDocAdapter = { read: async (id) => docs.get(id) ?? null, put: async (id, t) => void docs.set(id, t), remove: async (id) => void docs.delete(id), list: async (p) => [...docs.keys()].filter((k) => k.startsWith(p)).sort() }
	const store = createQueueStore({ eoa: SENDER, doc, codec: base64JsonCodec() })
	const newSenderPage = () => createSendQueue({ store, peer, resume: async () => ({ kind: 'failed' }), persistConfirmed: async () => true, heartbeatMs: 0, retryDelaysMs: [] })
	let sender = newSenderPage()

	// the recipient: two durable stores that survive its page, and the in-memory rows that do not (a library account's record keeps no bodies)
	const map = new Map<string, unknown>(); const data = new MemoryData()
	let recipient = await process_(map, data, 'purged')
	let rows: unknown[] = []
	const armors: string[] = []
	const appends: Array<Promise<string>> = []
	const arrive = (armor: string) => {
		armors.push(armor)
		const wire = armor.slice('armor:'.length)
		rows = makeMessage(rows as never, wire, 1_700_000_100_000, 'them', 'sent')
		const added = (rows as Row[]).filter((m) => m.sendId === 'once-1')
		appends.push(recipient.h.append({ peer, dir: 'in', ts: added[0]!.createdAt!, sendId: 'once-1', body: JSON.stringify(added[0]) }).then(() => 'resolved', (e) => `rejected:${(e as Error).message}`))
		return added.length
	}
	const restartRecipient = async () => { recipient = await process_(map, data, 'purged'); rows = []; await recipient.h.loadLocalManifest() }
	const perSendRows: number[] = []

	const wire = JSON.stringify({ sendId: 'once-1', from: 'me', text: 'synthetic once', createdAt: 1_700_000_000_000 })
	const attempt = async () => {
		const ctx = (await sender.armorContext('once-1'))!
		const armor = ctx.armor ?? `armor:${wire}`
		if (!ctx.armor) await ctx.record(armor, 'digest')
		perSendRows.push(arrive(armor))
		return { kind: 'awaiting' as const, persisted: true }
	}
	await sender.enqueue({ v: 1, sendId: 'once-1', peer, text: 'synthetic once', createdAt: 1_700_000_000_000, queuedAt: 1 }, { inline: true })
	// 1: the first copy; the recipient's page ends while its history network work is still running
	recipient.priv.uploadFragment = () => new Promise<string>(() => undefined)
	await sender.run('once-1', attempt, { inline: true })
	await settle()
	await restartRecipient()
	// 2: the retry of the same item (a real queue run), to the restarted recipient
	await sender.run('once-1', attempt); await settle()
	// 3: again, to the same page
	await sender.run('once-1', attempt); await settle()
	// 4: the sender's page ends too; the new one retries what is on its disk; the recipient restarts again
	sender.dispose(); sender = newSenderPage(); await sender.load()
	await restartRecipient()
	await sender.run('once-1', attempt); await settle()

	check('the same armor was posted four times (never sealed again)', armors.length === 4 && new Set(armors).size === 1, `${armors.length}/${new Set(armors).size}`)
	check('the sender still holds exactly one item', (await store.list()).length === 1)
	check('the recipient\'s row list holds one row at every arrival', perSendRows.join(',') === '1,1,1,1', perSendRows.join(','))
	await recipient.h.loadLocalManifest()
	const records = recipient.priv.manifest?.records.filter((r) => r.sendId === 'once-1').length
	const library = (await recipient.lib.openConversation(peer, VP)).items.filter((i) => (i.body ?? '').includes('"sendId":"once-1"')).length
	check('the durable library of the recipient holds exactly one row', library === 1, `rows=${library}`)
	check('the durable history index of the recipient holds exactly one record', records === 1, `records=${records}`)
	check('the later appends are confirmed (the mailbox line can be acknowledged)', (await Promise.all(appends.slice(1))).every((r) => r === 'resolved'))
	console.log(`inbound once: ${passes} passed, ${failures} failed`)
	process.exit(failures ? 1 : 0)
}
void main()
