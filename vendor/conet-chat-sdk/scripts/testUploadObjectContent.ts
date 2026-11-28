/**
 * What is handed to the upload interface AS THE OBJECT (`image`) is sealed bytes and nothing else: no wallet, peer, direction, time, message identifier, preview, request signature, pin request or receipt, in
 * clear or merely encoded, neither in the object nor in anything that names it. Real HistoryStore.append (inbound and outbound, a retry included); the network is stubbed at fetch level; synthetic values.
 * Run: npx tsx scripts/testUploadObjectContent.ts
 */
import { ethers } from 'ethers'
import { HistoryStore } from '../src/worker/history.js'
import { aesGcmDecryptString, keccakUtf8 } from '../src/crypto.js'
import { pinRequestField, pinRequestFor } from '../src/worker/pin-result.js'
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
const peer = '0x' + 'c7'.repeat(20)
const SEND_IDS = ['sendid-OUTBOUND-4411', 'sendid-INBOUND-9922']
const BODY_MARK = 'BODY-MARKER-do-not-store-in-clear'
const uploads: Array<{ keys: string[]; image: string; signMessage: string }> = []
const urls: string[] = []
const saved = new Map<string, string>()
const chain = { hash: '' }
let failPointer = true
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
	const u = String(url)
	urls.push(u)
	if (u.includes('/getFragment?')) {
		const body = saved.get(new URL(u).searchParams.get('hash') ?? '')
		return new Response(body ?? '', { status: body === undefined ? 404 : 200 })
	}
	if (u.endsWith('/storageFragment')) {
		const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
		uploads.push({ keys: Object.keys(sent).sort(), image: String(sent.image), signMessage: String(sent.signMessage) })
		saved.set(ethers.keccak256(ethers.toUtf8Bytes(String(sent.image))), String(sent.image))
		return new Response('{}', { status: 200 })
	}
	if (u.endsWith('/setChatIndexPointer')) {
		if (failPointer) return new Response('x', { status: 500 })
		chain.hash = (JSON.parse(String(init?.body)) as { indexHash: string }).indexHash
		return new Response('{"success":true}', { status: 200 })
	}
	throw new Error(`unexpected fetch ${u}`)
}) as never

async function main(): Promise<void> {
	const map = new Map<string, unknown>()
	const persistence = { get: async (k: string) => map.get(k), set: async (k: string, v: unknown) => void map.set(k, v), delete: async (k: string) => void map.delete(k), keys: async (p: string) => [...map.keys()].filter((k) => k.startsWith(p)) }
	const h = new HistoryStore(
		{ buffer: () => undefined, log: () => undefined } as never,
		{ eoaAddress: wallet.address, signing: wallet as unknown as never, chainId: 8453, ipfsBaseUrl: 'https://ipfs.test', conetRpcUrl: 'https://rpc.test', chatIndexRegistryAddress: '0x0000000000000000000000000000000000000001', apiBaseUrl: 'https://api.test', persistence: persistence as never, accountLock: sharedLockFor(map) },
	)
	await h.init()
	const priv = h as unknown as Record<string, unknown> & { indexKey: Uint8Array }
	priv.readOnchainPointer = async () => (chain.hash ? { indexHash: chain.hash, ts: 1n, seq: 1n } : null)
	priv.readPublishSnapshot = async () => ({ head: chain.hash || null, nonce: 0n })
	priv.ensureLocal = async () => { throw new Error('no library in this script') }
	priv.requireRowOrThrow = async () => undefined
	priv.ingestLocalAppend = async () => true
	priv.ensureLibraryRow = async () => undefined
	const entry = (i: number, dir: 'in' | 'out') => ({ peer, dir, ts: 1_700_000_777_000 + i, sendId: SEND_IDS[i]!, body: JSON.stringify({ sendId: SEND_IDS[i], text: `${BODY_MARK}-${i}` }) })
	const quiet = (p: Promise<void>) => p.catch(() => undefined)
	await quiet(h.append(entry(0, 'out')))
	await quiet(h.append(entry(1, 'in'))) // pointer fails
	failPointer = false
	await quiet(h.append(entry(1, 'in'))) // the retry

	check('objects were uploaded (fragments and indexes)', uploads.length >= 4, String(uploads.length))
	const selfSign = uploads[0]?.signMessage ?? ''
	const nonce = 'ab'.repeat(16)
	const forbidden: Array<[string, string]> = [
		['wallet', eoa.slice(2)], ['peer', peer.slice(2)], ['message identifier', SEND_IDS[0]!], ['message identifier', SEND_IDS[1]!], ['body or preview', BODY_MARK], ['time', '1700000777'], ['request signature', selfSign.slice(2, 66)],
		['field name wallet', '"wallet"'], ['field name signMessage', 'signMessage'], ['field name peer', '"peer"'], ['field name direction', '"dir"'], ['field name sendId', 'sendId'], ['field name preview', 'preview'], ['pin request', 'pinResult'], ['pin receipt', 'pinnedRecursive'], ['pin random value', nonce],
	]
	const forms = (value: string): string[] => [value, value.toUpperCase(), Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('hex')]
	const leaksOf = (text: string): string[] => {
		const decoded = [text, Buffer.from(text, 'base64').toString('latin1')]
		return forbidden.filter(([, v]) => forms(v).some((f) => f.length >= 6 && decoded.some((d) => d.toLowerCase().includes(f.toLowerCase())))).map(([label]) => label)
	}
	const leaked = uploads.flatMap((u, i) => leaksOf(u.image).map((l) => `object ${i}: ${l}`))
	check('no object holds wallet, peer, direction, time, identifier, preview, signature, pin request or receipt, in clear or encoded', leaked.length === 0, leaked.slice(0, 4).join('; '))
	check('every object is base64 and nothing else (no JSON wrapper, no data URL, no name)', uploads.every((u) => /^[A-Za-z0-9+/]+={0,2}$/.test(u.image) && Buffer.from(u.image, 'base64').toString('base64') === u.image))
	check('every object has the length of IV + ciphertext + tag and does not read as text', uploads.every((u) => { const b = Buffer.from(u.image, 'base64'); if (b.length < 12 + 16) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(b); return false } catch { return true } }))
	let opened = 0
	for (const u of uploads) { try { const m = JSON.parse(await aesGcmDecryptString(priv.indexKey, u.image)) as { records?: unknown }; if (Array.isArray(m.records)) opened += 1 } catch { /* a fragment: another key */ } }
	check('the index objects open only with the account key (sealed, in the published format)', opened >= 2, String(opened))
	check('the request around the object carries exactly the three published fields: nothing new travels with it', uploads.every((u) => u.keys.join() === 'image,signMessage,wallet'), uploads[0]?.keys.join())
	const names = urls.filter((u) => u.includes('/getFragment?')).map((u) => { const q = new URL(u).searchParams; return { keys: [...q.keys()].sort().join(), hash: q.get('hash') ?? '', rest: u } })
	check('objects are named by their content hash only', names.length > 0 && names.every((n) => /^0x[0-9a-f]{64}$/.test(n.hash) && saved.has(n.hash) && n.keys === 'hash,rb' && leaksOf(n.rest).length === 0), names[0]?.rest)
	check('the pin request is a field beside the object, never inside it', JSON.stringify(Object.keys(pinRequestField(nonce))) === '["v","nonce"]' && pinRequestFor(uploads[0]!.image, nonce).hash === keccakUtf8(uploads[0]!.image))
	// positive control of the detector itself
	check('the detector does see a wrapped object', leaksOf(Buffer.from(JSON.stringify({ wallet: eoa, signMessage: 'x', image: 'y' })).toString('base64')).includes('wallet') && leaksOf(`{"sendId":"${SEND_IDS[0]}"}`).length > 0)
	console.log(`\n${passes} passed, ${failures} failed`)
	if (failures) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(2) })
