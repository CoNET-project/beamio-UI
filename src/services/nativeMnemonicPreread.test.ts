/**
 * @jest-environment node
 */
/**
 * Spec items 59(2)(a) and 60: the start-up pre-read answer maps to valid / absent / unknown. The result carries `state`
 * (`{state:"valid", eoa, phrase}`, `{state:"absent"}`, `{state:"unknown"}`). Anything outside the closed set is unknown, and a valid
 * answer must derive its EOA. The request carries `seq` from the shared sequence (item 60(1)). SYNTHETIC values only: the BIP-39 public
 * test vector (not an account).
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { buildNativeMnemonicPrereadCommand, prereadFromAnswer, queryNativeMnemonicPreread, NATIVE_MNEMONIC_PREREAD_COMMAND } from './nativeRecovery'
import { createShellTxSeq, type SeqStorage } from './shellTxSeq'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })
const refused = (error: string) => ({ kind: 'payload', payload: { type: 'ack', ok: false, error } })

function memoryStorage(): SeqStorage {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

describe('nativeMnemonicPreread: valid / absent / unknown', () => {
	it('the command name is the name', () => {
		expect(NATIVE_MNEMONIC_PREREAD_COMMAND).toBe('nativeMnemonicPreread')
	})

	it('the request carries the integer seq of item 60(1), with the command type', () => {
		expect(buildNativeMnemonicPrereadCommand(7)).toEqual({ type: 'nativeMnemonicPreread', seq: 7 })
	})

	it('each pre-read draws a new seq from the shared sequence; a retry is never older than the request before it', async () => {
		const seqs: number[] = []
		const send = async (cmd: { type: string; seq: number }) => {
			seqs.push(cmd.seq)
			return refused('stale_seq')
		}
		const nextSeq = createShellTxSeq(memoryStorage(), () => 1000)
		await queryNativeMnemonicPreread(nextSeq, send)
		await queryNativeMnemonicPreread(nextSeq, send)
		expect(seqs).toHaveLength(2)
		expect(Number.isSafeInteger(seqs[0])).toBe(true)
		expect(seqs[1]).toBeGreaterThan(seqs[0])
	})

	it('valid: a state of valid with eoa and phrase, the phrase deriving the answered EOA (PV-01)', () => {
		expect(prereadFromAnswer(ack({ state: 'valid', eoa: EOA, phrase: PHRASE }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})

	it('valid with an EOA that does not derive from the phrase is unknown, not valid', () => {
		expect(prereadFromAnswer(ack({ state: 'valid', eoa: '0x' + '1'.repeat(40), phrase: PHRASE }))).toEqual({ kind: 'unknown' })
	})

	it('a result under the older field names (nativeState, mnemonic) is outside the closed set: unknown, not valid', () => {
		expect(prereadFromAnswer(ack({ nativeState: 'valid', eoa: EOA, mnemonic: PHRASE }))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer(ack({ nativeState: 'absent' }))).toEqual({ kind: 'unknown' })
	})

	it('absent, and explicit_empty (the same answer under its other name), are confirmed empty (PV-02)', () => {
		expect(prereadFromAnswer(ack({ state: 'absent' }))).toEqual({ kind: 'absent' })
		expect(prereadFromAnswer(ack({ state: 'explicit_empty' }))).toEqual({ kind: 'absent' })
	})

	it('unknown, an error, a timeout, a refusal and an unrecognised value are unknown, never absent (PV-03)', () => {
		expect(prereadFromAnswer(ack({ state: 'unknown' }))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer(ack({ state: 'pending' }))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer(ack('something-new'))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'timeout' })).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'unavailable' })).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, result: 'absent' } })).toEqual({ kind: 'unknown' })
		// spec item 1: a refused read (ok:false, untrusted_source) is unknown and keeps the start-up wait, never onboarding
		expect(prereadFromAnswer(refused('untrusted_source'))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer({ kind: 'payload', payload: null })).toEqual({ kind: 'unknown' })
	})

	it('stale_seq and bad_request (item 60(3)(b)(c)) are unknown, never absent and never valid: the start-up wait, not onboarding', () => {
		expect(prereadFromAnswer(refused('stale_seq'))).toEqual({ kind: 'unknown' })
		expect(prereadFromAnswer(refused('bad_request'))).toEqual({ kind: 'unknown' })
		// a refusal that carries a valid-looking result is still a refusal
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'stale_seq', result: { state: 'absent' } } })).toEqual({
			kind: 'unknown',
		})
	})

	it('a valid answer without a phrase is unknown', () => {
		expect(prereadFromAnswer(ack({ state: 'valid', eoa: EOA }))).toEqual({ kind: 'unknown' })
	})
})
