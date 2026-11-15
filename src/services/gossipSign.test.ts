/**
 * @jest-environment node
 *
 * shape checks and the duplicate-key scan. Pure functions; SYNTHETIC values only.
 */
import { checkGossipMessage, hasDuplicateKey, utf8ByteLength } from './gossipSign'

const EOA = '0x39581c72b8c7d0de85ff22cf3ae178ae813957aa'
const ACK = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ command: 'gossip_delivery_ack', walletAddress: EOA, armorHash: '0x' + 'ab'.repeat(32), timestamp: 1762900000, ...over })

describe('hasDuplicateKey', () => {
	it('finds a repeated key at the top level and in nested objects', () => {
		expect(hasDuplicateKey('{"a":1,"a":2}')).toBe(true)
		expect(hasDuplicateKey('{"x":{"b":1,"b":2}}')).toBe(true)
		expect(hasDuplicateKey('{"x":[{"b":1},{"b":2}]}')).toBe(false)
	})

	it('decodes escaped spellings, and never treats a string value as a key', () => {
		expect(hasDuplicateKey('{"comm\\u0061nd":1,"command":2}')).toBe(true)
		expect(hasDuplicateKey('{"a":"a","b":"a"}')).toBe(false)
	})
})

describe('utf8ByteLength', () => {
	it('counts bytes, not characters', () => {
		expect(utf8ByteLength('hello')).toBe(5)
		expect(utf8ByteLength('é')).toBe(2)
		expect(utf8ByteLength('😀')).toBe(4)
	})
})

describe('checkGossipMessage: gossip kind (rules 1 to 8)', () => {
	it('accepts the ack shape', () => {
		expect(checkGossipMessage('gossip', ACK(), EOA)).toEqual({ ok: true })
	})

	it('refuses in rule order', () => {
		expect(checkGossipMessage('gossip', 'x'.repeat(2049), EOA)).toEqual({ ok: false, code: 'too_long' })
		expect(checkGossipMessage('gossip', 'hello', EOA)).toEqual({ ok: false, code: 'not_json' })
		expect(checkGossipMessage('gossip', '[1]', EOA)).toEqual({ ok: false, code: 'not_json' })
		expect(checkGossipMessage('gossip', ACK({ extra: 1 }), EOA)).toEqual({ ok: false, code: 'unknown_key' })
		expect(checkGossipMessage('gossip', ACK({ command: 'wallet_online_query' }), EOA)).toEqual({ ok: false, code: 'command' })
		expect(checkGossipMessage('gossip', ACK({ walletAddress: '0x' + '11'.repeat(20) }), EOA)).toEqual({ ok: false, code: 'wallet_mismatch' })
		expect(checkGossipMessage('gossip', ACK({ armorHash: '0xAB' }), EOA)).toEqual({ ok: false, code: 'armor_hash' })
		expect(checkGossipMessage('gossip', ACK({ timestamp: 999999999 }), EOA)).toEqual({ ok: false, code: 'timestamp' })
		expect(checkGossipMessage('gossip', ACK({ timestamp: 1.5 }), EOA)).toEqual({ ok: false, code: 'timestamp' })
		expect(checkGossipMessage('gossip', ACK({ sendId: '' }), EOA)).toEqual({ ok: false, code: 'send_id' })
	})

	it('a wallet address in another letter case is the same account', () => {
		expect(checkGossipMessage('gossip', ACK({ walletAddress: EOA.toUpperCase().replace('0X', '0x') }), EOA)).toEqual({ ok: true })
	})
})

describe('checkGossipMessage: envelope and group kinds (cross-purpose)', () => {
	it('an ack shape is refused on envelope and group', () => {
		expect(checkGossipMessage('envelope', ACK(), EOA)).toEqual({ ok: false, code: 'cross_purpose' })
		expect(checkGossipMessage('group', ACK(), EOA)).toEqual({ ok: false, code: 'cross_purpose' })
	})

	it('a duplicate key that could hide an ack is refused', () => {
		expect(checkGossipMessage('envelope', '{"command":"gossip_delivery_ack","command":"x"}', EOA)).toEqual({ ok: false, code: 'cross_purpose' })
	})

	it('ordinary envelopes and text pass unchanged', () => {
		expect(checkGossipMessage('envelope', 'hello', EOA)).toEqual({ ok: true })
		expect(checkGossipMessage('envelope', '{"command":"wallet_online_query","walletAddress":"0x1"}', EOA)).toEqual({ ok: true })
	})

	it('a kind outside the enumeration is refused', () => {
		expect(checkGossipMessage('history', 'hello', EOA)).toEqual({ ok: false, code: 'kind' })
	})
})
