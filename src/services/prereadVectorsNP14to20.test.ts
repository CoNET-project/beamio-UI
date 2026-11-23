/**
 * @jest-environment node
 */
/**
 * Preread vectors NP-14 to NP-20 (mnemonic-preread-vectors.v4.json, sha256 24398a75; supplement 32 and the supersession 092c1b04).
 * The vector phrase "SYNTHETIC-TEST-PHRASE-NOT-A-WALLET" is a placeholder and is not a BIP-39 phrase, so the PWA side runs on the BIP-39 public
 * test vector (`abandon … about`, derives 0x9858…). Mapping: with eoa → NP-14, NP-15; eoa differs → NP-16 (shell side), NP-19, NP-20
 * (PWA side, verify_failed, no write); no eoa → NP-18 (capability missing). NP-14 to NP-16 and NP-17 are answered by the native shell and are
 * checked here as the reply shapes the PWA accepts; their store/vault source is not reproduced in the PWA.
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { prereadFromAnswer } from './nativeRecovery'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const E1 = '0x9858effd232b4033e47d90003d41ec34ecaeda94' // derived from PHRASE
const E2 = '0x58a57ed9d8d624cbd12e2c467d34787555bb1b25' // another account
const ok = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

describe('NP-14 / NP-15: ok with the mnemonic and its eoa is valid for that eoa (store source, vault fallback source)', () => {
	it('NP-14 store current plaintext: the reply eoa equals the derived address → valid', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE, eoa: E1 }))).toEqual({ kind: 'valid', eoa: E1, phrase: PHRASE })
	})
	it('NP-15 store empty, vault fallback: the vault account eoa equals the derived address → valid', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE, eoa: E1 }))).toMatchObject({ kind: 'valid' })
	})
})

describe('NP-16 (shell side): the reply carries the store eoa E1 and a diagnostic; the PWA accepts the reply whose eoa matches its derivation', () => {
	it('NP-16 reply with eoa E1 (the store) and the diagnostic field → valid for E1 (the diagnostic is not a PWA verdict)', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE, eoa: E1, diagnostic: 'store_vault_eoa_mismatch' }))).toEqual({
			kind: 'valid',
			eoa: E1,
			phrase: PHRASE,
		})
	})
})

describe('NP-17: an untrusted page request is refused by the shell: untrusted_source, nothing read, nothing valid', () => {
	it('ok false, untrusted_source → unknown (never valid, never absent)', () => {
		const out = prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source' } })
		expect(out.kind).toBe('unknown')
		expect(out.kind === 'valid' || out.kind === 'absent').toBe(false)
	})
})

describe('NP-18: an old shell that replies a plaintext without eoa is the capability-missing path (no invented behaviour, no reference address)', () => {
	it('ok mnemonic without eoa → unknown with reason unsupported, never valid, never a write', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE }))).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})
})

describe('NP-19 (PWA side): the derived address D differs from the reply eoa → verify_failed, nothing written', () => {
	it('D = E1 and the reply eoa = E2 → unknown with reason verify_failed', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE, eoa: E2 }))).toEqual({ kind: 'unknown', reason: 'verify_failed' })
	})
})

describe('NP-20 (PWA side): D equals the reply eoa; the local record check is the gate (see AppEntryGate.startupTwoState NP-20)', () => {
	it('D = E1 and the reply eoa = E1 → valid: the reply reaches the gate, where a different local account address is verify_failed', () => {
		expect(prereadFromAnswer(ok({ code: 'ok', mnemonic: PHRASE, eoa: E1 }))).toEqual({ kind: 'valid', eoa: E1, phrase: PHRASE })
	})
})
