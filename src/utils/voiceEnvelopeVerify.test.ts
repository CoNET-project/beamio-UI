/**
 * @jest-environment node
 *
 * draft-v55 §62: a chat line carries the offer only inside a signed envelope; the outer signer equals envelope.from and the
 * inner from. Real EIP-191 signatures; no key is stored.
 */
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
jest.mock('./cashTreesNativePwaLog', () => ({ publishNativePwaLog: () => {} }))
jest.mock('./cashTreesNativeNfc', () => ({ dispatchNativeSystemCallAction: jest.fn() }))

import { Wallet } from 'ethers'
import { makeVoiceCallSignal, parseVoiceCallSignal, signVoiceCallOffer, storedVoiceSignal, verifiedVoiceOfferFromLine, verifiedVoiceSignalFromLine } from './voiceCallSession'

const TO = '0x000000000000000000000000000000000000dEaD'

async function innerOffer(w: { address: string; privateKey: string }, callId = 'env-call-1', sessionId = 'env-session-1'): Promise<string> {
	const base = makeVoiceCallSignal({
		type: 'voice_call_offer_v1', proto: 3, callId, sessionId, from: w.address, to: TO,
		codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=', expiresAt: Date.now() + 900_000,
	})
	const signed = await signVoiceCallOffer({ ...base, createdAt: Date.now(), timestamp: Date.now() }, w.privateKey)
	return JSON.stringify(signed)
}

async function envelope(signer: { address: string; signMessage: (m: string) => Promise<string> }, text: string, from?: string): Promise<string> {
	const signMessage = await signer.signMessage(text)
	return JSON.stringify({ timestamp: Date.now(), text, signMessage, ...(from !== undefined ? { from } : { from: signer.address }) })
}

describe('verifiedVoiceOfferFromLine (v55 §62)', () => {
	test('a signed envelope whose outer signer equals envelope.from and inner from is accepted', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		const out = verifiedVoiceOfferFromLine(await envelope(w, text))
		expect(out?.callId).toBe('env-call-1')
	})
	test('an envelope without from is refused (envelope.from is required, v54 §61.2)', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		const signMessage = await w.signMessage(text)
		expect(verifiedVoiceOfferFromLine(JSON.stringify({ text, signMessage }))).toBeNull()
		expect(verifiedVoiceOfferFromLine(JSON.stringify({ text, signMessage, from: 42 }))).toBeNull()
	})
	test('an envelope without the outer signature is refused silently', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		expect(verifiedVoiceOfferFromLine(JSON.stringify({ text, from: w.address }))).toBeNull()
	})
	test('outer envelope valid but the inner offer signature wrong is refused silently (inner check kept)', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		// same fields, but the signed inner text was altered after signing: the inner signature no longer recovers the signer
		const tampered = text.replace('env-call-1', 'env-call-9')
		expect(verifiedVoiceOfferFromLine(await envelope(w, tampered))).toBeNull()
	})
	test('a bare offer JSON (no envelope) is refused', async () => {
		const w = Wallet.createRandom()
		expect(verifiedVoiceOfferFromLine(await innerOffer(w))).toBeNull()
	})
	test('an outer signature by another key than the inner from is refused', async () => {
		const owner = Wallet.createRandom()
		const other = Wallet.createRandom()
		const text = await innerOffer(owner)
		expect(verifiedVoiceOfferFromLine(await envelope(other, text, other.address))).toBeNull()
	})
	test('envelope.from different from the outer signer is refused', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		expect(verifiedVoiceOfferFromLine(await envelope(w, text, '0x1111111111111111111111111111111111111111'))).toBeNull()
	})
	test('a signature over a different text is refused', async () => {
		const w = Wallet.createRandom()
		const text = await innerOffer(w)
		const tampered = text.replace('env-call-1', 'env-call-2')
		const sig = await w.signMessage(text)
		expect(verifiedVoiceOfferFromLine(JSON.stringify({ text: tampered, signMessage: sig, from: w.address }))).toBeNull()
	})
	test('a nested envelope inside the text is refused (the text must be the offer itself)', async () => {
		const w = Wallet.createRandom()
		const inner = await innerOffer(w)
		const nested = await envelope(w, inner)
		expect(verifiedVoiceOfferFromLine(await envelope(w, nested))).toBeNull()
	})
	test('garbage and non-JSON are refused', () => {
		expect(verifiedVoiceOfferFromLine('not json')).toBeNull()
		expect(verifiedVoiceOfferFromLine('{}')).toBeNull()
	})
})

describe('verifiedVoiceSignalFromLine: non-offer signals need the same outer envelope (v54 §61)', () => {
	const endText = (w: { address: string }, callId = 'end-call-1', sessionId = 'end-session-1', from?: string) =>
		JSON.stringify(makeVoiceCallSignal({
			type: 'voice_end_v1', callId, sessionId, from: from ?? w.address, to: TO,
		}))
	test('a voice_end_v1 inside a verified envelope is accepted', async () => {
		const w = Wallet.createRandom()
		const out = verifiedVoiceSignalFromLine(await envelope(w, endText(w)))
		expect(out?.type).toBe('voice_end_v1')
	})
	test('a bare voice_end_v1 (no envelope) is refused', async () => {
		const w = Wallet.createRandom()
		expect(verifiedVoiceSignalFromLine(endText(w))).toBeNull()
	})
	test('a voice_end_v1 whose inner from is not the outer signer is refused', async () => {
		const w = Wallet.createRandom()
		const other = Wallet.createRandom()
		expect(verifiedVoiceSignalFromLine(await envelope(w, endText(w, 'c', 's', other.address)))).toBeNull()
	})
	test('an offer is not returned as a non-offer path (verifiedVoiceOfferFromLine only returns offers)', async () => {
		const w = Wallet.createRandom()
		expect(verifiedVoiceOfferFromLine(await envelope(w, endText(w)))).toBeNull()
	})
})

describe('stored rows: only the voiceVerified marker makes a voice text a call signal', () => {
	test('an escaped nested voice text is detected after unwrapping (the gate sees it)', () => {
		const end = JSON.stringify(makeVoiceCallSignal({ type: 'voice_end_v1', callId: 'n-1', sessionId: 'n-s', from: '0x1111111111111111111111111111111111111111', to: TO }))
		expect(parseVoiceCallSignal(JSON.stringify({ text: end }))?.type).toBe('voice_end_v1')
	})
	test('an escaped nested envelope with a bad outer signature is refused by the verified gate', () => {
		const end = JSON.stringify(makeVoiceCallSignal({ type: 'voice_end_v1', callId: 'n-2', sessionId: 'n-s2', from: '0x1111111111111111111111111111111111111111', to: TO }))
		expect(verifiedVoiceSignalFromLine(JSON.stringify({ text: end, signMessage: '0x' + '11'.repeat(65), from: '0x1111111111111111111111111111111111111111' }))).toBeNull()
	})
	test('an unmarked row (history, backfill, cache) never becomes a call signal', () => {
		const end = JSON.stringify(makeVoiceCallSignal({ type: 'voice_end_v1', callId: 'h-1', sessionId: 'h-s', from: '0x1111111111111111111111111111111111111111', to: TO }))
		expect(storedVoiceSignal({ text: end })).toBeNull()
		expect(storedVoiceSignal({ text: end, voiceVerified: false })).toBeNull()
		expect(storedVoiceSignal(null)).toBeNull()
	})
	test('a marked row is read as its signal', () => {
		const end = JSON.stringify(makeVoiceCallSignal({ type: 'voice_end_v1', callId: 'h-2', sessionId: 'h-s2', from: '0x1111111111111111111111111111111111111111', to: TO }))
		expect(storedVoiceSignal({ text: end, voiceVerified: true })?.type).toBe('voice_end_v1')
	})
	test('a non-offer signal without an inner from is refused silently (v68 §75)', async () => {
		const w = Wallet.createRandom()
		const noFrom = JSON.stringify({ type: 'voice_end_v1', callId: 'f-1', sessionId: 'f-s', to: TO, timestamp: Date.now() })
		expect(verifiedVoiceSignalFromLine(await envelope(w, noFrom))).toBeNull()
	})
})
