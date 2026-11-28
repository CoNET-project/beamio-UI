/** The v1.1 pin-result judgement (src/worker/pin-result.ts) with positive and negative replies. Synthetic values; no network. Run: npx tsx scripts/testPinResult.ts */
import { judgePinReply, pinRequestFor, pinnedPeersCover } from '../src/worker/pin-result.js'
import { pinCoversAll } from '../src/worker/history-batch.js'

let failures = 0
let passes = 0
const check = (name: string, ok: boolean): void => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
const content = 'cipher-text-é中'
const q = pinRequestFor(content, 'ab'.repeat(16))
const node = () => ({ peerId: 'peer-1', result: 'verified', reason: null, cid: 'cid-1', pinnedRecursive: true, offlineKeccak: q.hash, offlineLength: q.length, checkedAt: 1 })
const good = () => ({ ok: true, hash: q.hash, pin: { v: 1, nonce: q.nonce, id: q.hash, length: q.length, status: 'pinned', reason: null, configuredNodes: 1, verifiedNodes: 1, nodes: [node()] } })
check('the length is the UTF-8 byte length', q.length === Buffer.byteLength(content, 'utf8') && q.length !== content.length)
check('a complete reply is pinned and covers its request', pinCoversAll([q], [judgePinReply(200, good(), q)]))
check('one good node among bad ones is enough', pinCoversAll([q], [judgePinReply(200, { ...good(), pin: { ...good().pin, nodes: [{ ...node(), result: 'failed' }, node()] } }, q)]))
type Reply = ReturnType<typeof good>
const pinWith = (patch: object) => (r: Reply) => ({ ...r, pin: { ...r.pin, ...patch } })
const nodeWith = (patch: object) => pinWith({ nodes: [{ ...node(), ...patch }] })
const bad: Array<[string, (r: Reply) => unknown, number?]> = [
	['HTTP 500 with a pinned body', (r) => r, 500],
	['not JSON', () => null],
	['an old server: no pin field', () => ({ ok: true, hash: q.hash })],
	['accepted only', () => ({ ok: true, hash: q.hash, accepted: true })],
	['pin.v 2', pinWith({ v: 2 })],
	['another nonce (an earlier or cached reply)', pinWith({ nonce: 'cd'.repeat(16) })],
	['another pin.id', pinWith({ id: `0x${'0'.repeat(64)}` })],
	['another reply hash', (r) => ({ ...r, hash: `0x${'0'.repeat(64)}` })],
	['another length', pinWith({ length: q.length + 1 })],
	['length as text', pinWith({ length: String(q.length) })],
	...['pending', 'not_pinned', 'unknown', 'error', 'Pinned', 'ok', ''].map((s): [string, (r: Reply) => unknown] => [`status ${JSON.stringify(s)}`, pinWith({ status: s })]),
	['no status', pinWith({ status: undefined })],
	['no nodes', pinWith({ nodes: [] })],
	['nodes not a list', pinWith({ nodes: node() })],
	['node not verified', nodeWith({ result: 'unknown' })],
	['not recursively pinned', nodeWith({ pinnedRecursive: false })],
	['pinnedRecursive as text', nodeWith({ pinnedRecursive: 'true' })],
	['no cid', nodeWith({ cid: null })],
	['empty peerId', nodeWith({ peerId: '' })],
	['offline keccak of other content', nodeWith({ offlineKeccak: `0x${'1'.repeat(64)}` })],
	['the v1 field offlineSha256 only', nodeWith({ offlineKeccak: undefined, offlineSha256: q.hash })],
	['offline length differs', nodeWith({ offlineLength: q.length - 1 })],
]
for (const [label, change, status] of bad) {
	const result = judgePinReply(status ?? 200, change(good()), q)
	check(`${label}: not pinned`, result.state !== 'pinned' && !result.contentVerified && !pinCoversAll([q], [result]))
}
check('with a trusted list, an unlisted node does not count', judgePinReply(200, good(), q, { minDistinctPeers: 1, trustedPeers: new Set(['peer-2']) }).state !== 'pinned' && judgePinReply(200, good(), q, { minDistinctPeers: 1, trustedPeers: new Set(['peer-1']) }).state === 'pinned')
const twice = { ...good(), pin: { ...good().pin, verifiedNodes: 2, configuredNodes: 2, nodes: [node(), node()] } }
check('two required: the same peer listed twice counts once, and the entry\'s own total is not used', judgePinReply(200, twice, q, { minDistinctPeers: 2 }).state !== 'pinned')
const two = { ...good(), pin: { ...good().pin, verifiedNodes: 0, nodes: [node(), { ...node(), peerId: 'peer-2' }] } }
check('two required: two different peers pass', judgePinReply(200, two, q, { minDistinctPeers: 2 }).state === 'pinned')
check('a minimum below one never passes', judgePinReply(200, good(), q, { minDistinctPeers: 0 }).state !== 'pinned')
const on = (peers: string[]) => ({ ...judgePinReply(200, good(), q), peers })
check('one batch, different nodes: allowed or not by parameter', pinnedPeersCover([on(['a']), on(['b'])], 1, false) && !pinnedPeersCover([on(['a']), on(['b'])], 1, true) && pinnedPeersCover([on(['a', 'b']), on(['b'])], 1, true) && !pinnedPeersCover([], 1, false))
const q2 = pinRequestFor('second object', 'ef'.repeat(16))
check('a batch of two with one proof is not covered; one object\'s proof never stands for another', !pinCoversAll([q, q2], [judgePinReply(200, good(), q)]) && !pinCoversAll([q2], [judgePinReply(200, good(), q2)]))
console.log(`pin result: ${passes} passed, ${failures} failed`)
if (failures) process.exit(1)
