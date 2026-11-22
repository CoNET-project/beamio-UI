/**
 * @jest-environment node
 *
 * Late tag revoke and exact handle matching, run on the real module (the helper is pure; the dismiss path is observed
 * through the mocked native dispatch).
 */
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
jest.mock('./cashTreesNativePwaLog', () => ({ publishNativePwaLog: () => {} }))
jest.mock('./cashTreesNativeNfc', () => ({ dispatchNativeSystemCallAction: jest.fn() }))

import { Wallet } from 'ethers'
import { dispatchNativeSystemCallAction } from './cashTreesNativeNfc'
import {
	dismissNativeIncomingVoiceCall,
	exactIncomingVoiceOffer,
	forgetIncomingVoiceOffer,
	isVoiceCallOfferRinging,
	makeVoiceCallSignal,
	markVoiceCallTerminal,
	rememberIncomingVoiceOffer,
	dismissRevokedIncomingCall,
	revokeRingForLateTag,
	signVoiceCallOffer,
	type VoiceCallSignal,
} from './voiceCallSession'

const TO = '0x000000000000000000000000000000000000dEaD'
let n = 0
const uniq = (p: string) => {
	n += 1
	return `${p}-${n}-${Date.now()}`
}

async function signed(callId: string, sessionId: string, callerTag?: string): Promise<VoiceCallSignal> {
	const w = Wallet.createRandom()
	const base = makeVoiceCallSignal({
		type: 'voice_call_offer_v1', proto: 3, callId, sessionId, from: w.address, to: TO,
		codec: 'audio/pcm;rate=16000', callerPgp: 'cGdw', callerRoute: 'cm91dGU=',
		expiresAt: Date.now() + 900_000, ...(callerTag ? { callerTag } : {}),
	})
	return signVoiceCallOffer({ ...base, createdAt: Date.now(), timestamp: Date.now() }, w.privateKey)
}

const spies = () => ({
	dismissNative: jest.fn(),
	forget: jest.fn(),
	markTerminal: jest.fn(),
	clearLayer: jest.fn(),
	recordDeclined: jest.fn(),
})

beforeEach(() => {
	jest.clearAllMocks()
})

describe('revokeRingForLateTag', () => {
	test('a looked-up tag that differs from the declared one revokes: every effect runs once, with this call', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		const s = await signed(callId, sessionId, 'alice')
		const d = spies()
		expect(revokeRingForLateTag(s, '@bob', d)).toBe(true)
		for (const fn of Object.values(d)) expect(fn).toHaveBeenCalledTimes(1)
		for (const fn of Object.values(d)) expect(fn).toHaveBeenCalledWith(callId, sessionId)
	})
	test('an empty lookup (查不到标签) revokes nothing', async () => {
		const s = await signed(uniq('c'), uniq('s'), 'alice')
		const d = spies()
		expect(revokeRingForLateTag(s, '', d)).toBe(false)
		for (const fn of Object.values(d)) expect(fn).not.toHaveBeenCalled()
	})
	test('a matching tag revokes nothing; no declared tag revokes nothing', async () => {
		const s = await signed(uniq('c'), uniq('s'), 'alice')
		const d = spies()
		expect(revokeRingForLateTag(s, '@ALICE', d)).toBe(false)
		const plain = await signed(uniq('c'), uniq('s'))
		expect(revokeRingForLateTag(plain, '@bob', d)).toBe(false)
		for (const fn of Object.values(d)) expect(fn).not.toHaveBeenCalled()
	})
})

describe('after the revoke the offer cannot ring again (terminal)', () => {
	test('markVoiceCallTerminal makes a re-delivery of the same handles not ringing', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		const s = await signed(callId, sessionId, 'alice')
		rememberIncomingVoiceOffer(s)
		expect(isVoiceCallOfferRinging(s)).toBe(true)
		markVoiceCallTerminal(callId, sessionId)
		expect(isVoiceCallOfferRinging(s)).toBe(false)
	})
})

describe('exact handle matching: a different call sharing one handle is never taken', () => {
	test('same callId, other sessionId: the stored offer is not returned and not forgotten', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		const stored = await signed(callId, sessionId)
		rememberIncomingVoiceOffer(stored)
		expect(exactIncomingVoiceOffer(callId, uniq('other'))).toBeNull()
		forgetIncomingVoiceOffer(callId, uniq('other'))
		expect(exactIncomingVoiceOffer(callId, sessionId)).not.toBeNull()
	})
	test('same sessionId, other callId: the stored offer is not returned and not forgotten', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		const stored = await signed(callId, sessionId)
		rememberIncomingVoiceOffer(stored)
		expect(exactIncomingVoiceOffer(uniq('other'), sessionId)).toBeNull()
		forgetIncomingVoiceOffer(uniq('other'), sessionId)
		expect(exactIncomingVoiceOffer(callId, sessionId)).not.toBeNull()
	})
	test('dismiss for another call sharing a handle ends only that call\'s own handles', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		rememberIncomingVoiceOffer(await signed(callId, sessionId))
		const other = uniq('other')
		dismissNativeIncomingVoiceCall(callId, other)
		const calls = (dispatchNativeSystemCallAction as jest.Mock).mock.calls
		expect(calls.length).toBe(1)
		expect(calls[0][1]).toEqual({ callId, sessionId: other })
		// the stored call is still remembered
		expect(exactIncomingVoiceOffer(callId, sessionId)).not.toBeNull()
	})
})

describe('revoke dismisses with the local-only shell action (no endSystemCall, no uplink)', () => {
	test('dismissRevokedIncomingCall sends dismissIncomingSystemCall with this call only, and forgets it', async () => {
		const callId = uniq('c'), sessionId = uniq('s')
		rememberIncomingVoiceOffer(await signed(callId, sessionId, 'alice'))
		jest.clearAllMocks()
		dismissRevokedIncomingCall(callId, sessionId)
		expect(dispatchNativeSystemCallAction).toHaveBeenCalledTimes(1)
		expect(dispatchNativeSystemCallAction).toHaveBeenCalledWith('dismissIncomingSystemCall', { callId, sessionId })
		expect(exactIncomingVoiceOffer(callId, sessionId)).toBeNull()
	})
})
