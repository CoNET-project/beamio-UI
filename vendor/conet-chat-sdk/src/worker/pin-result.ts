/**
 * The judgement of one upload reply's `pin` field (upload-reply pin result v1.1, spec sha256 740d9b60..., still under review). Pure: it sends nothing and nothing in the product calls it yet.
 * One object is pinned only when everything below holds for THIS request; anything missing, unknown or of another type is not pinned. A reply without `pin` (an old server, a cache) is not pinned.
 * The verified nodes are counted HERE, by distinct peer id; the entry's own totals are not used. With the default policy the evidence is only this: one node said, in this request, that it holds the object pinned.
 */
import { keccakUtf8 } from '../crypto.js'
import type { PinRequest, PinResult } from './history-batch.js'

/** the request field added to a storageFragment body (a new random value every time) */
export const pinRequestField = (nonce: string): { v: 1; nonce: string } => ({ v: 1, nonce })

/** what is asked about one object: its identifier and UTF-8 byte length, computed here from the bytes that were sent */
export const pinRequestFor = (content: string, nonce: string): PinRequest => ({ hash: keccakUtf8(content), length: new TextEncoder().encode(content).length, nonce })

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/** not decided yet by the owner, hence parameters: how many DIFFERENT nodes must have verified one object, and whether they must be on a built-in list. Whether the objects of one batch may rest on different nodes is `sameNodesForBatch` of pinnedPeersCover. */
export interface PinPolicy { minDistinctPeers: number; trustedPeers?: ReadonlySet<string> }
export const DEFAULT_PIN_POLICY: PinPolicy = { minDistinctPeers: 1 }

/** true: the batch may be confirmed under `sameNodesForBatch` (at least `minDistinctPeers` nodes verified EVERY object). Without it, each object is judged on its own (pinCoversAll). */
export function pinnedPeersCover(results: ReadonlyArray<PinResult & { peers?: readonly string[] }>, minDistinctPeers: number, sameNodesForBatch: boolean): boolean {
	if (!results.length || !results.every((r) => r.state === 'pinned' && (r.peers?.length ?? 0) >= minDistinctPeers)) return false
	if (!sameNodesForBatch) return true
	return results.reduce<string[]>((common, r) => common.filter((p) => r.peers!.includes(p)), [...results[0]!.peers!]).length >= minDistinctPeers
}

/** `reply`: the parsed JSON body (null when it is not JSON) */
export function judgePinReply(httpStatus: number, reply: unknown, request: PinRequest, policy: PinPolicy = DEFAULT_PIN_POLICY): PinResult & { peers?: string[] } {
	const no = (state: string): PinResult => ({ state, hash: request.hash, length: request.length, nonce: request.nonce, contentVerified: false })
	if (!(httpStatus >= 200 && httpStatus < 300)) return no('http_error')
	const body = record(reply)
	const pin = record(body?.pin)
	if (!body || !pin || pin.v !== 1) return no('no_pin_result')
	if (pin.nonce !== request.nonce) return no('nonce_mismatch')
	if (!same(pin.id, request.hash) || !same(body.hash, request.hash)) return no('id_mismatch')
	if (pin.length !== request.length) return no('length_mismatch')
	// pinned | pending | not_pinned | unknown | error (and anything else): only the first can confirm
	if (pin.status !== 'pinned') return no(pin.status === 'pending' || pin.status === 'not_pinned' || pin.status === 'error' ? pin.status : 'unknown')
	const peers = new Set<string>()
	for (const n of Array.isArray(pin.nodes) ? pin.nodes : []) {
		const node = record(n)
		if (!node || node.result !== 'verified' || node.pinnedRecursive !== true || !filled(node.cid) || !filled(node.peerId) || !same(node.offlineKeccak, request.hash) || node.offlineLength !== request.length) continue
		const peer = String(node.peerId).trim()
		if (!policy.trustedPeers || policy.trustedPeers.has(peer)) peers.add(peer)
	}
	// a policy asking for fewer than one node is not a policy
	const need = Number.isInteger(policy.minDistinctPeers) && policy.minDistinctPeers >= 1 ? policy.minDistinctPeers : Infinity
	return peers.size >= need ? { state: 'pinned', hash: request.hash, length: request.length, nonce: request.nonce, contentVerified: true, peers: [...peers] } : no('no_verified_node')
}
