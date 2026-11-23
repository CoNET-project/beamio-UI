/**
 * @jest-environment node
 *
 * Unit (b), the decision rule 4 (pre-read answer shapes, synthetic values only):
 * - not_ready is one class in both shapes: iOS ok:true with result.code 'not_ready', Android envelope ok:false error 'not_ready';
 * - an envelope refusal (untrusted_source, key_over_bridge_refused, bad_request, stale_seq) is unknown with its closed code, never absent;
 * - a valid answer must derive its own EOA; a mismatched or undecodable phrase is unknown;
 * - absent and valid keep their meaning.
 */
import { prereadFromAnswer } from './nativeRecovery'
import { ethers } from 'ethers'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = ethers.Wallet.fromPhrase(PHRASE).address.toLowerCase()

describe('pre-read answer shapes (unit b)', () => {
	it('iOS shape: ok:true with result.code not_ready is the not_ready class', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { code: 'not_ready' } } })).toEqual({ kind: 'unknown', reason: 'not_ready' })
	})

	it('Android shape: envelope ok:false error not_ready is the same not_ready class', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_ready' } })).toEqual({ kind: 'unknown', reason: 'not_ready' })
	})

	it.each(['untrusted_source', 'key_over_bridge_refused', 'bad_request', 'stale_seq'])('envelope refusal %s is unknown with its code, never absent or valid', (code) => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: code } })).toEqual({ kind: 'unknown', reason: 'envelope_error', code })
	})

	it('a transport answer that is not a payload is unknown (no code)', () => {
		expect(prereadFromAnswer({ kind: 'timeout' })).toEqual({ kind: 'unknown' })
	})

	it('a valid answer whose phrase derives the stated EOA is valid (iOS result.state form)', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94' } } })).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})

	it('a code ok answer with a phrase is valid with the EOA the phrase derives', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { code: 'ok', mnemonic: PHRASE, eoa: '0x9858effd232b4033e47d90003d41ec34ecaeda94' } } })).toMatchObject({ kind: 'valid' })
	})

	it('absent is absent (the shipped shape); explicit_empty and a bare string result are not shipped shapes: unknown', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { code: 'confirmed_missing' } } })).toEqual({ kind: 'absent' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { state: 'explicit_empty' } } })).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: 'absent' } })).toEqual({ kind: 'unknown' })
	})
})
