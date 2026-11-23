/**
 * @jest-environment node
 *
 * Admission of an incoming offer (draft-v33 §33.2, v36 §40, v37 §41 and §41.4): one admission per (callId, sessionId).
 * The offers are really signed (EIP-191) with a throwaway wallet; no key is stored.
 */
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
jest.mock('./cashTreesNativePwaLog', () => ({ publishNativePwaLog: () => {} }))

import { Wallet } from 'ethers'
import {
	admitIncomingVoiceOffer,
	isVoiceCallOfferRinging,
	setIncomingOfferTagLookup,
	makeVoiceCallSignal,
	signVoiceCallOffer,
	type VoiceCallSignal,
} from './voiceCallSession'
import { voiceOfferDedup } from './voiceOfferDedup'

const TO = '0x000000000000000000000000000000000000dEaD'

async function signedOffer(opts: {
	callId: string
	sessionId: string
	createdAt?: number
	expiresAt?: number
	from?: string | null
}): Promise<{ signal: VoiceCallSignal; signer: string }> {
	const wallet = Wallet.createRandom()
	const now = Date.now()
	const base = makeVoiceCallSignal({
		type: 'voice_call_offer_v1',
		proto: 3,
		callId: opts.callId,
		sessionId: opts.sessionId,
		from: opts.from === undefined ? wallet.address : (opts.from as string),
		to: TO,
		codec: 'audio/pcm;rate=16000',
		callerPgp: 'cGdw',
		callerRoute: 'cm91dGU=',
		expiresAt: opts.expiresAt ?? now + 900_000,
	})
	const withCreated: VoiceCallSignal = {
		...base,
		createdAt: opts.createdAt ?? now,
		timestamp: opts.createdAt ?? now,
	}
	const signal = await signVoiceCallOffer(withCreated, wallet.privateKey)
	return { signal, signer: wallet.address.toLowerCase() }
}

beforeEach(() => {
	// the table is module state: each test uses fresh handles
})

let seq = 0
const handle = () => {
	seq += 1
	return { callId: `adm-call-${seq}-${Date.now()}`, sessionId: `adm-session-${seq}-${Date.now()}` }
}

describe('admitIncomingVoiceOffer', () => {
	test('a valid offer is admitted once; the same offer again is a duplicate (shell and chat page share the table)', async () => {
		const h = handle()
		const { signal, signer } = await signedOffer(h)
		const first = admitIncomingVoiceOffer(signal)
		expect(first).toEqual({ ok: true, callerEoa: signer })
		expect(admitIncomingVoiceOffer(signal)).toEqual({ ok: false, reason: 'duplicate' })
	})

	test('an offer outside the late window (now > expiresAt) is refused', async () => {
		const h = handle()
		const past = Date.now() - 1000
		const { signal } = await signedOffer({ ...h, createdAt: past - 900_000, expiresAt: past })
		expect(admitIncomingVoiceOffer(signal)).toEqual({ ok: false, reason: 'late_window' })
	})

	test('from missing is refused', async () => {
		const h = handle()
		const { signal } = await signedOffer({ ...h, from: '' })
		expect(admitIncomingVoiceOffer(signal)).toEqual({ ok: false, reason: 'from_missing' })
	})

	test('from that does not match the signer is refused', async () => {
		const h = handle()
		const { signal } = await signedOffer({ ...h, from: '0x1111111111111111111111111111111111111111' })
		expect(admitIncomingVoiceOffer(signal)).toEqual({ ok: false, reason: 'from_mismatch' })
	})

	test('createdAt missing is refused, and such an offer does not count as ringing', async () => {
		const h = handle()
		// signed without an issue time (the signature covers the same text the verifier rebuilds)
		const wallet = Wallet.createRandom()
		const base = makeVoiceCallSignal({
			type: 'voice_call_offer_v1', proto: 3, callId: h.callId, sessionId: h.sessionId,
			from: wallet.address, to: TO, codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=',
			expiresAt: Date.now() + 900_000,
		})
		const noIssue = { ...base, createdAt: undefined, timestamp: undefined } as unknown as VoiceCallSignal
		const signed = await signVoiceCallOffer(noIssue, wallet.privateKey)
		expect(isVoiceCallOfferRinging(signed)).toBe(false)
		expect(admitIncomingVoiceOffer(signed)).toEqual({ ok: false, reason: 'no_created_at' })
	})

	test('only createdAt is the issue time: timestamp alone does not admit or ring (v20 §22, v21 §23)', async () => {
		const h = handle()
		const wallet = Wallet.createRandom()
		const base = makeVoiceCallSignal({
			type: 'voice_call_offer_v1', proto: 3, callId: h.callId, sessionId: h.sessionId,
			from: wallet.address, to: TO, codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=',
			expiresAt: Date.now() + 900_000,
		})
		const onlyTimestamp = { ...base, createdAt: undefined, timestamp: Date.now() } as unknown as VoiceCallSignal
		const signed = await signVoiceCallOffer(onlyTimestamp, wallet.privateKey)
		expect(isVoiceCallOfferRinging(signed)).toBe(false)
		expect(admitIncomingVoiceOffer(signed)).toEqual({ ok: false, reason: 'no_created_at' })
	})

	test('a declared tag that differs from the looked-up tag of the signer is refused (v10 §12, v18 §18.1)', async () => {
		const h = handle()
		const wallet = Wallet.createRandom()
		const base = makeVoiceCallSignal({
			type: 'voice_call_offer_v1', proto: 3, callId: h.callId, sessionId: h.sessionId,
			from: wallet.address, to: TO, codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=',
			expiresAt: Date.now() + 900_000, callerTag: 'alice',
		})
		const signed = await signVoiceCallOffer({ ...base, createdAt: Date.now(), timestamp: Date.now() }, wallet.privateKey)
		expect(admitIncomingVoiceOffer(signed, Date.now(), '@bob')).toEqual({ ok: false, reason: 'tag_mismatch' })
		// the refusal did not register the offer
		expect(admitIncomingVoiceOffer(signed, Date.now(), '@alice')).toEqual({ ok: true, callerEoa: wallet.address.toLowerCase() })
	})

	test('the registered tag lookup applies to every admission path (shell applyNative included)', async () => {
		const wallet = Wallet.createRandom()
		const base = makeVoiceCallSignal({
			type: 'voice_call_offer_v1', proto: 3, callId: handle().callId, sessionId: handle().sessionId,
			from: wallet.address, to: TO, codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=',
			expiresAt: Date.now() + 900_000, callerTag: 'alice',
		})
		const signed = await signVoiceCallOffer({ ...base, createdAt: Date.now(), timestamp: Date.now() }, wallet.privateKey)
		setIncomingOfferTagLookup(() => '@bob')
		try {
			expect(admitIncomingVoiceOffer(signed)).toEqual({ ok: false, reason: 'tag_mismatch' })
		} finally {
			setIncomingOfferTagLookup(null)
		}
		// no lookup result: the declared tag cannot be decided here; the offer is admitted and never shows the tag
		expect(admitIncomingVoiceOffer(signed).ok).toBe(true)
	})

	test('isAdmitted is read-only: true after admission, false for a refused handle', async () => {
		const h = handle()
		const { signal } = await signedOffer({ ...h, from: '0x3333333333333333333333333333333333333333' })
		expect(voiceOfferDedup.isAdmitted(h.callId, h.sessionId)).toBe(false)
		expect(admitIncomingVoiceOffer(signal).ok).toBe(false)
		expect(voiceOfferDedup.isAdmitted(h.callId, h.sessionId)).toBe(false)
		const ok = handle()
		const good = await signedOffer(ok)
		expect(admitIncomingVoiceOffer(good.signal).ok).toBe(true)
		expect(voiceOfferDedup.isAdmitted(ok.callId, ok.sessionId)).toBe(true)
	})

	test('a refused offer is not registered: a corrected delivery of the same handle is still admitted', async () => {
		const h = handle()
		const { signal, signer } = await signedOffer({ ...h, from: '0x2222222222222222222222222222222222222222' })
		expect(admitIncomingVoiceOffer(signal).ok).toBe(false)
		// the table did not record the refused offer
		expect(voiceOfferDedup.register(h.callId, h.sessionId, signer)).toEqual({ ok: true })
	})
})

import { offerReplacesLiveCall } from './voiceCallSession'

describe('offerReplacesLiveCall (v70 §77)', () => {
	const now = Date.now()
	const live = new Set(['live-s'])
	const ringing = (over: Record<string, unknown> = {}) => ({
		callId: 'o-1', sessionId: 'other-s', createdAt: now, timestamp: now, expiresAt: now + 900_000, ...over,
	})
	test('a ringing offer that arrived after the current call started replaces it', () => {
		expect(offerReplacesLiveCall(ringing(), live, now - 60_000)).toBe(true)
	})
	test('the current call itself never replaces it', () => {
		expect(offerReplacesLiveCall(ringing({ sessionId: 'live-s' }), live, now - 60_000)).toBe(false)
	})
	test('an older offer (before the current call started) does not replace it', () => {
		expect(offerReplacesLiveCall(ringing({ createdAt: now - 120_000, timestamp: now - 120_000 }), live, now - 60_000)).toBe(false)
	})
	test('a terminal or expired offer does not replace it', () => {
		expect(offerReplacesLiveCall(ringing({ expiresAt: now - 1 }), live, now - 60_000)).toBe(false)
	})
	test('no live call or unknown start: nothing is detached', () => {
		expect(offerReplacesLiveCall(ringing(), new Set(), now - 60_000)).toBe(false)
		expect(offerReplacesLiveCall(ringing(), live, 0)).toBe(false)
	})
})
