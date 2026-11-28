/**
 * Chat history sync: the remote index is the on-chain pointer plus the IPFS fragment it names.
 *
 * A. Fresh device (empty local mirror), remote index holds 3 records: adopt; no storageFragment write, no pointer write.
 * B. Local holds a prefix of the remote index: adopt; no write.
 * C. Local equals the remote index: no write, no change.
 * D. A record exists only locally: a sync leaves it unpublished (current behaviour); the next append publishes it with the new record.
 * E. Record key semantics: records with the same sendId collapse to one; the local copy is kept, the remote copy is dropped.
 *
 * Environment: Node ${process.version}; synthetic wallet, in-memory persistence, stubbed network (no real RPC, IPFS or relay).
 * Run: npx tsx scripts/testHistorySyncAdopt.ts
 */

import { ethers } from 'ethers'
import { HistoryStore } from '../src/worker/history.js'
import { aesGcmDecryptString, aesGcmEncryptString, keccakUtf8 } from '../src/crypto.js'

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail?: string): void {
	if (ok) passes++
	else failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

type Rec = { seq: number; cid: string; prevCid: string; ts: number; peer: string; dir: string; sendId: string; preview: string }
type Net = { storageWrites: number; pointerWrites: number }
/** The on-chain pointer and the fragment it names (a stand-in for the registry and IPFS). */
type Chain = { hash: string; cipher: string }

const wallet = ethers.Wallet.createRandom()
const peer = '0x' + '22'.repeat(20)

/** A consistent chain of records from genesis. */
function chain(genesis: string, count: number, tag: string): Rec[] {
	const out: Rec[] = []
	let prev = genesis
	for (let i = 0; i < count; i++) {
		const cid = keccakUtf8(`${tag}-fragment-${i}`)
		out.push({ seq: i, cid, prevCid: prev, ts: 1_700_000_000_000 + i, peer, dir: 'in', sendId: `${tag}-send-${i}`, preview: `${tag}-${i}` })
		prev = cid
	}
	return out
}

let active: Net = { storageWrites: 0, pointerWrites: 0 }
let lastUploadedCipher = ''

/** storageFragment POSTs are counted into the active scenario and their body is kept as the uploaded cipher. */
const realFetch = globalThis.fetch
/** what the storage stub holds, by content hash: an upload is read back by its hash */
const savedFragments = new Map<string, string>()
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input)
	if (url.includes('/storageFragment') && init?.method === 'POST') {
		active.storageWrites += 1
		lastUploadedCipher = (JSON.parse(String(init.body)) as { image: string }).image
		savedFragments.set(ethers.keccak256(ethers.toUtf8Bytes(lastUploadedCipher)), lastUploadedCipher)
	}
	if (url.includes('/getFragment?')) {
		const body = savedFragments.get(new URL(url).searchParams.get('hash') ?? '')
		return new Response(body ?? '', { status: body === undefined ? 404 : 200 })
	}
	return new Response(url.includes('/setChatIndexPointer') ? '{"success":true}' : '{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

function makeStore(persistence: Map<string, unknown>, net: Net, onchain: Chain) {
	const store = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined },
		{
			eoaAddress: wallet.address,
			signing: wallet as unknown as never,
			chainId: 8453,
			ipfsBaseUrl: 'https://ipfs.test',
			conetRpcUrl: 'https://rpc.test',
			chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001',
			apiBaseUrl: 'https://api.test',
			persistence: {
				get: async (k: string) => persistence.get(k),
				set: async (k: string, v: unknown) => void persistence.set(k, v),
				remove: async (k: string) => void persistence.delete(k),
			} as never,
		},
	)
	const s = store as unknown as Record<string, (...a: unknown[]) => unknown>
	s.readOnchainPointer = async () => (onchain.hash ? { indexHash: onchain.hash, ts: 1n, seq: 1n } : null)
	s.fetchIndexCipherByHash = async (hash: string) => (hash === onchain.hash ? onchain.cipher : null)
	s.updateOnchainPointer = async (indexHash: string) => {
		active.pointerWrites += 1
		// The pointer moves to the index that was just uploaded.
		if (keccakUtf8(lastUploadedCipher) !== indexHash) throw new Error('pointer names an index that was not uploaded')
		onchain.hash = indexHash
		onchain.cipher = lastUploadedCipher
		return true
	}
	return store
}

async function encryptedManifest(store: HistoryStore, records: Rec[]): Promise<string> {
	const key = (store as unknown as { indexKey: Uint8Array }).indexKey
	return aesGcmEncryptString(key, JSON.stringify({ v: 1, eoa: wallet.address.toLowerCase(), updatedAt: 1, records }))
}

async function recordsOf(store: HistoryStore, cipher: string): Promise<Rec[]> {
	const key = (store as unknown as { indexKey: Uint8Array }).indexKey
	return (JSON.parse(await aesGcmDecryptString(key, cipher)) as { records: Rec[] }).records
}

async function main(): Promise<void> {
	// Remote head: 3 records, built with a throwaway store so the index key matches.
	const probe = makeStore(new Map(), { storageWrites: 0, pointerWrites: 0 }, { hash: '', cipher: '' })
	await probe.init()
	const genesis = (probe as unknown as { genesisCid: string }).genesisCid
	const remoteRecs = chain(genesis, 3, 'remote')
	const remoteCipher = await encryptedManifest(probe, remoteRecs)
	const remoteHead: Chain = { hash: keccakUtf8(remoteCipher), cipher: remoteCipher }
	const fresh = (): Chain => ({ ...remoteHead })

	// A. Fresh device: no local mirror, the remote index holds 3 records. Adopt; write nothing.
	{
		const persistence = new Map<string, unknown>()
		const net: Net = { storageWrites: 0, pointerWrites: 0 }
		active = net
		const store = makeStore(persistence, net, fresh())
		const changed = await store.syncFromHead()
		const count = (store as unknown as { manifest: { records: Rec[] } | null }).manifest?.records.length ?? -1
		check('A fresh device: no storageFragment write on sync', net.storageWrites === 0, `storageFragment POSTs=${net.storageWrites}`)
		check('A fresh device: no on-chain pointer write on sync', net.pointerWrites === 0, `pointer writes=${net.pointerWrites}`)
		check('A fresh device: local mirror adopts the 3 remote records', count === 3, `records=${count}`)
		check('A fresh device: the local change is reported to the caller', changed === true, `changed=${changed}`)
		check('A fresh device: the local mirror is saved', persistence.size === 1, `persisted keys=${persistence.size}`)
	}

	// B. Local holds only the first 2 remote records (a prefix). The remote index adds one: adopt, write nothing.
	{
		const persistence = new Map<string, unknown>()
		const seed = makeStore(persistence, { storageWrites: 0, pointerWrites: 0 }, fresh())
		await seed.init()
		persistence.set((seed as unknown as { localIndexKey(): string }).localIndexKey(), await encryptedManifest(seed, remoteRecs.slice(0, 2)))
		const net: Net = { storageWrites: 0, pointerWrites: 0 }
		active = net
		const store = makeStore(persistence, net, fresh())
		const changed = await store.syncFromHead()
		const count = (store as unknown as { manifest: { records: Rec[] } | null }).manifest?.records.length ?? -1
		check('B remote ahead of local: no storageFragment write on sync', net.storageWrites === 0, `storageFragment POSTs=${net.storageWrites}`)
		check('B remote ahead of local: no pointer write on sync', net.pointerWrites === 0, `pointer writes=${net.pointerWrites}`)
		check('B remote ahead of local: local mirror now holds the 3 remote records', count === 3, `records=${count}`)
		check('B remote ahead of local: reported as changed', changed === true, `changed=${changed}`)
	}

	// C. Local already equals the remote index: nothing to write, nothing changed.
	{
		const persistence = new Map<string, unknown>()
		const seed = makeStore(persistence, { storageWrites: 0, pointerWrites: 0 }, fresh())
		await seed.init()
		persistence.set((seed as unknown as { localIndexKey(): string }).localIndexKey(), await encryptedManifest(seed, remoteRecs))
		const net: Net = { storageWrites: 0, pointerWrites: 0 }
		active = net
		const store = makeStore(persistence, net, fresh())
		const changed = await store.syncFromHead()
		check('C equal local: no write and no change', net.storageWrites === 0 && net.pointerWrites === 0 && changed === false, `writes=${net.storageWrites}/${net.pointerWrites} changed=${changed}`)
	}

	// D. A record exists only locally. A sync does not publish it (current behaviour; whether sync should is an open decision for the owner).
	//    The next append publishes it together with the new record: one fragment write, one index write, one pointer write.
	{
		const onchain = fresh()
		const persistence = new Map<string, unknown>()
		const seed = makeStore(persistence, { storageWrites: 0, pointerWrites: 0 }, onchain)
		await seed.init()
		const localOnly: Rec = {
			seq: 3,
			cid: keccakUtf8('local-only-fragment'),
			prevCid: remoteRecs[2].cid,
			ts: 1_700_000_100_000,
			peer,
			dir: 'out',
			sendId: 'local-only-send',
			preview: 'local-only',
		}
		persistence.set((seed as unknown as { localIndexKey(): string }).localIndexKey(), await encryptedManifest(seed, [...remoteRecs, localOnly]))

		const syncNet: Net = { storageWrites: 0, pointerWrites: 0 }
		active = syncNet
		const store = makeStore(persistence, syncNet, onchain)
		const changed = await store.syncFromHead()
		check('D sync does not publish a local-only record (no storageFragment write)', syncNet.storageWrites === 0, `storageFragment POSTs=${syncNet.storageWrites}`)
		check('D sync leaves the pointer alone', syncNet.pointerWrites === 0, `pointer writes=${syncNet.pointerWrites}`)
		check('D sync reports no change', changed === false, `changed=${changed}`)
		const before = await recordsOf(seed, onchain.cipher)
		check('D the remote index still lacks the local-only record', !before.some((r) => r.cid === localOnly.cid), `remote records=${before.length}`)

		const appendNet: Net = { storageWrites: 0, pointerWrites: 0 }
		active = appendNet
		await store.append({ peer, dir: 'out', ts: 1_700_000_200_000, sendId: 'new-send', body: 'new message' })
		check('D append publishes: one fragment and one index storageFragment write', appendNet.storageWrites === 2, `storageFragment POSTs=${appendNet.storageWrites}`)
		check('D append moves the pointer once', appendNet.pointerWrites === 1, `pointer writes=${appendNet.pointerWrites}`)
		const after = await recordsOf(seed, onchain.cipher)
		check('D the published index names the local-only record and the new record', after.some((r) => r.cid === localOnly.cid) && after.some((r) => r.sendId === 'new-send'), `remote records=${after.length}`)
	}

	// E. Key semantics (recordKey): same sendId collapses to one record, the local copy is kept, the remote copy is dropped.
	{
		const store = makeStore(new Map(), { storageWrites: 0, pointerWrites: 0 }, fresh())
		await store.init()
		const localCopy: Rec = { ...remoteRecs[1], cid: keccakUtf8('local-copy-of-remote-1') }
		const remoteCopy: Rec = { ...remoteRecs[1] }
		const merged = (store as unknown as { unionMergeRecords(l: Rec[], r: Rec[]): Rec[] }).unionMergeRecords([localCopy], [remoteCopy])
		check('E same sendId: one record after the union', merged.length === 1, `records=${merged.length}`)
		check('E same sendId: the local copy is kept, the remote copy is dropped', merged[0]?.cid === localCopy.cid, `kept=${merged[0]?.cid}`)
	}

	globalThis.fetch = realFetch
	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures > 0) process.exit(1)
}

main().catch((ex) => {
	globalThis.fetch = realFetch
	console.error(ex)
	process.exit(1)
})
