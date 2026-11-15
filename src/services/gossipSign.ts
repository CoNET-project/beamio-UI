/**
 * gossipSign: the shape checks before an EIP-191 signature (interface notice 26; shared gossip vectors).
 *
 * The signed bytes are the caller's string, UTF-8, exactly: no domain prefix, no re-serialisation, no trim, no NFC or NFKD.
 * The checks below refuse a message before any key is used. They never change the bytes that are signed.
 *
 * `gossip` kind: the only shape is the delivery ack `gossip_delivery_ack` (rules 1 to 8 of).
 * `envelope` and `group` kinds: unchanged bytes, but a JSON object whose `command` is `gossip_delivery_ack` is refused
 * (cross-purpose): a relayed envelope signature must not be replayable as a mailbox ack. A duplicate top-level key
 * is refused on these kinds too, since another parser could read the ack value from it.
 * Any other kind is refused (`kind`).
 *
 * Pure: no key, no wallet, no I/O.
 */

export const GOSSIP_MAX_BYTES = 2048
export const GOSSIP_ACK_COMMAND = 'gossip_delivery_ack'
const GOSSIP_KEYS: readonly string[] = ['command', 'walletAddress', 'armorHash', 'timestamp', 'sendId']
const ARMOR_HASH = /^0x[0-9a-f]{64}$/
const TS_MIN = 1_000_000_000
const TS_MAX = 9_999_999_999

export type GossipKind = 'gossip' | 'envelope' | 'group'
export type GossipRejectCode =
	| 'kind'
	| 'too_long'
	| 'not_json'
	| 'duplicate_key'
	| 'unknown_key'
	| 'command'
	| 'wallet_mismatch'
	| 'armor_hash'
	| 'timestamp'
	| 'send_id'
	| 'cross_purpose'
	| 'payload_rejected'

export type GossipCheck = { ok: true } | { ok: false; code: GossipRejectCode }

const fail = (code: GossipRejectCode): GossipCheck => ({ ok: false, code })

/** UTF-8 byte length of a string, without TextEncoder (not every test environment has it). Lone surrogates count as 3. */
export function utf8ByteLength(s: string): number {
	let n = 0
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0
		n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
	}
	return n
}

/**
 * True when some object in a text that is already valid JSON repeats a key (decoded, so escaped spellings count too).
 * Keys are the strings followed by `:` directly inside an object; values are never mistaken for keys.
 */
export function hasDuplicateKey(text: string): boolean {
	const stack: Array<{ isObject: boolean; keys: Set<string> }> = []
	const n = text.length
	let i = 0
	while (i < n) {
		const c = text[i]
		if (c === '"') {
			let j = i + 1
			while (j < n) {
				const d = text[j]
				if (d === '\\') {
					j += 2
					continue
				}
				if (d === '"') break
				j++
			}
			const raw = text.slice(i, j + 1)
			const value = JSON.parse(raw) as string
			let k = j + 1
			while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r')) k++
			const top = stack[stack.length - 1]
			if (top && top.isObject && text[k] === ':') {
				if (top.keys.has(value)) return true
				top.keys.add(value)
			}
			i = j + 1
			continue
		}
		if (c === '{') stack.push({ isObject: true, keys: new Set() })
		else if (c === '[') stack.push({ isObject: false, keys: new Set() })
		else if (c === '}' || c === ']') stack.pop()
		i++
	}
	return false
}

function parseObject(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text) as unknown
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/** The `gossip` kind: rules 1 to 8 of, in that order. */
function checkAckShape(message: string, eoa: string): GossipCheck {
	const o = parseObject(message)
	if (o === null) return fail('not_json')
	if (hasDuplicateKey(message)) return fail('duplicate_key')
	for (const k of Object.keys(o)) if (!GOSSIP_KEYS.includes(k)) return fail('unknown_key')
	if (o.command !== GOSSIP_ACK_COMMAND) return fail('command')
	if (typeof o.walletAddress !== 'string' || o.walletAddress.toLowerCase() !== eoa.toLowerCase()) return fail('wallet_mismatch')
	if (typeof o.armorHash !== 'string' || !ARMOR_HASH.test(o.armorHash)) return fail('armor_hash')
	if (typeof o.timestamp !== 'number' || !Number.isInteger(o.timestamp) || o.timestamp < TS_MIN || o.timestamp > TS_MAX) {
		return fail('timestamp')
	}
	if ('sendId' in o && (typeof o.sendId !== 'string' || o.sendId.length === 0)) return fail('send_id')
	return { ok: true }
}

/** Checks one request before signing. `eoa` is the unlocked account (any letter case). */
export function checkGossipMessage(kind: string, message: string, eoa: string): GossipCheck {
	if (kind !== 'gossip' && kind !== 'envelope' && kind !== 'group') return fail('kind')
	if (utf8ByteLength(message) > GOSSIP_MAX_BYTES) return fail('too_long')
	if (kind === 'gossip') return checkAckShape(message, eoa)
	const o = parseObject(message)
	if (o === null) return { ok: true }
	if (hasDuplicateKey(message)) return fail('cross_purpose')
	if (o.command === GOSSIP_ACK_COMMAND) return fail('cross_purpose')
	return { ok: true }
}
