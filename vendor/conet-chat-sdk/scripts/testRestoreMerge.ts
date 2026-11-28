/**
 * Restore on a device that already holds records of its own. The records of the head are MERGED into the local index and returned by load() whatever happens to the publication; a publication that cannot be completed
 * only means that nothing is published. The same script runs against earlier releases of this module: RESTORE_SDK_SRC=<their src directory>.
 * Real HistoryStore, network stubbed at fetch level, synthetic wallet and rows. Run: npx tsx scripts/testRestoreMerge.ts
 */
import { ethers } from 'ethers'
import { sharedLockFor } from './fixtures/historyHarness.js'

let failures = 0
let passes = 0
const check = (name: string, ok: boolean, detail?: string): void => {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` - ${detail}` : ''}`)
}

const wallet = ethers.Wallet.createRandom()
const peer = '0x' + '22'.repeat(20)
const saved = new Map<string, string>()
const chain = { hash: '', seq: 0 }
type Fault = 'none' | 'pointer_http_500' | 'pointer_200_success_false' | 'readback_differs_for_new_uploads' | 'unrelated_damaged_pending_list' | 'one_rewritten_record_upload_fails'
const net: { fault: Fault; fresh: Set<string> } = { fault: 'none', fresh: new Set() }

globalThis.fetch = (async (url: string, init?: { body?: string }) => {
	const u = String(url)
	if (u.includes('/getFragment?')) {
		const hash = new URL(u).searchParams.get('hash') ?? ''
		const body = saved.get(hash)
		if (net.fault === 'readback_differs_for_new_uploads' && net.fresh.has(hash)) return new Response('', { status: 404 })
		return new Response(body ?? '', { status: body === undefined ? 404 : 200 })
	}
	if (u.endsWith('/storageFragment')) {
		const image = String((JSON.parse(String(init?.body)) as { image: string }).image)
		// only the FIRST upload of the restore fails (a re-written record); every later one, the index included, works
		if (net.fault === 'one_rewritten_record_upload_fails' && net.fresh.size === 0) { net.fresh.add('failed-once'); return new Response('x', { status: 502 }) }
		const hash = ethers.keccak256(ethers.toUtf8Bytes(image))
		if (!saved.has(hash) && net.fault === 'readback_differs_for_new_uploads') net.fresh.add(hash)
		saved.set(hash, image)
		return new Response('{}', { status: 200 })
	}
	if (u.endsWith('/setChatIndexPointer')) {
		if (net.fault === 'pointer_http_500') return new Response('x', { status: 500 })
		if (net.fault === 'pointer_200_success_false') return new Response('{"success":false}', { status: 200 })
		const sent = JSON.parse(String(init?.body)) as { indexHash: string; seq: string }
		chain.hash = sent.indexHash
		chain.seq = Number(sent.seq)
		return new Response('{"success":true}', { status: 200 })
	}
	throw new Error(`unexpected fetch ${u}`)
}) as never

async function main(): Promise<void> {
	const src = process.env.RESTORE_SDK_SRC || new URL('../src', import.meta.url).pathname
	const { HistoryStore } = (await import(`${src}/worker/history.ts`)) as { HistoryStore: new (emit: unknown, opts: unknown) => { init(): Promise<void>; append(e: unknown): Promise<void>; load(o?: unknown): Promise<void> } }
	const process_ = async (map: Map<string, unknown>) => {
		const seen: string[] = []
		const h = new HistoryStore(
			{ buffer: (_p: string, entries: Array<{ body: string }>) => { for (const e of entries) seen.push((JSON.parse(e.body) as { sendId: string }).sendId) }, log: () => undefined },
			{ eoaAddress: wallet.address, signing: wallet, privateKeyHex: wallet.privateKey, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: { get: async (k: string) => map.get(k), set: async (k: string, v: unknown) => void map.set(k, v), delete: async (k: string) => void map.delete(k), remove: async (k: string) => void map.delete(k), keys: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)) }, accountLock: sharedLockFor(map) },
		)
		await h.init()
		const priv = h as unknown as Record<string, unknown>
		priv.readOnchainPointer = async () => (chain.hash ? { indexHash: chain.hash, ts: 1n, seq: BigInt(chain.seq) } : null)
		priv.provider = { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0]) }
		priv.readPublishSnapshot = async () => ({ head: chain.hash || null, nonce: 0n })
		return { h, seen, priv }
	}
	const entry = (sendId: string, ts: number) => ({ peer, dir: 'out' as const, ts, sendId, body: JSON.stringify({ sendId, text: `synthetic-${sendId}` }) })
	const quiet = async (p: Promise<void>) => p.catch(() => undefined)

	for (const fault of ['none', 'pointer_200_success_false', 'readback_differs_for_new_uploads', 'unrelated_damaged_pending_list', 'one_rewritten_record_upload_fails', 'pointer_http_500'] as const) {
		saved.clear(); chain.hash = ''; chain.seq = 0; net.fault = 'none'; net.fresh = new Set()
		const mine = new Map<string, unknown>()
		const theirs = new Map<string, unknown>()
		// this device holds a record of its own that never reached the head
		net.fault = 'pointer_http_500'
		await quiet((await process_(mine)).h.append(entry('own-1', 1_700_000_000_000)))
		// another device publishes two records
		net.fault = 'none'
		const other = await process_(theirs)
		await quiet(other.h.append(entry('their-1', 1_700_000_000_100)))
		await quiet(other.h.append(entry('their-2', 1_700_000_000_200)))
		// restore on this device while the publication cannot be completed
		net.fault = fault
		// a pending list that cannot be read has nothing to do with the records being restored (earlier releases do not have this key at all)
		if (fault === 'unrelated_damaged_pending_list') mine.set(`beamio.chat.history.remotepending:${wallet.address.toLowerCase()}`, '{damaged')
		const headBefore = chain.hash
		const restored = await process_(mine)
		await restored.h.load()
		const got = [...new Set(restored.seen)].sort().join(',')
		check(`restore, ${fault}: load returns the records of the head together with this device's own`, got === 'own-1,their-1,their-2', got)
		// a second start of the same device still shows them (the merge is on disk)
		const again = await process_(mine)
		await again.h.load({ localOnly: true, emit: 'all' })
		const got2 = [...new Set(again.seen)].sort().join(',')
		check(`restore, ${fault}: after a restart the local index still holds all of them`, got2 === 'own-1,their-1,their-2', got2)
		if (fault !== 'none' && process.env.RESTORE_SDK_SRC === undefined) check(`restore, ${fault}: nothing was published over the head`, chain.hash === headBefore, 'head moved')
	}
	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
