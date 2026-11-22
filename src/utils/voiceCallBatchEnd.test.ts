/**
 * @jest-environment node
 *
 * Batch end marking: only a verified chat envelope counts (outer signer == envelope.from == inner from). Real EIP-191
 * signatures; the legacy 'any signer' and nested-only reads are gone.
 */
jest.mock('@/services/beamioTagWorkerBridge', () => ({}), { virtual: true })
jest.mock('./cashTreesNativePwaLog', () => ({ publishNativePwaLog: () => {} }))

import { Wallet } from 'ethers'
import { voiceCallHandlesEndedInBatch } from './voiceCallSession'

const TO = '0x000000000000000000000000000000000000dEaD'

/** A signed chat envelope carrying `signal` (text is the signal JSON, signMessage over text). */
async function envelope(w: { address: string; signMessage: (m: string) => Promise<string> }, signal: Record<string, unknown>): Promise<string> {
	const text = JSON.stringify({ ...signal, from: w.address, to: TO, timestamp: Date.now() })
	return JSON.stringify({ timestamp: Date.now(), text, from: w.address, signMessage: await w.signMessage(text) })
}

test('an end in a verified batch marks both ids of that call', async () => {
	const w = Wallet.createRandom()
	const ended = voiceCallHandlesEndedInBatch([
		await envelope(w, { type: 'voice_end_v1', callId: 'c1', sessionId: 's1' }),
		await envelope(w, { type: 'voice_call_offer_v1', callId: 'c2', sessionId: 's2' }),
	])
	expect([...ended].sort()).toEqual(['c1', 's1'])
})

test('decline and timeout count as ended when verified', async () => {
	const w = Wallet.createRandom()
	const ended = voiceCallHandlesEndedInBatch([
		await envelope(w, { type: 'voice_call_reject_v1', callId: 'c3', sessionId: 's3' }),
		await envelope(w, { type: 'voice_call_timeout_v1', callId: 'c4', sessionId: 's4' }),
	])
	expect(ended.has('c3') && ended.has('s4')).toBe(true)
})

test('an end without a valid envelope signature is ignored', async () => {
	const w = Wallet.createRandom()
	const bare = JSON.stringify({ type: 'voice_end_v1', callId: 'c1', sessionId: 's1', from: w.address })
	expect(voiceCallHandlesEndedInBatch([bare]).size).toBe(0)
})

test('an end signed by a key other than envelope.from is ignored (no other signer may end a call)', async () => {
	const owner = Wallet.createRandom()
	const other = Wallet.createRandom()
	const text = JSON.stringify({ type: 'voice_end_v1', callId: 'c5', sessionId: 's5', from: owner.address, to: TO })
	const forged = JSON.stringify({ timestamp: Date.now(), text, from: owner.address, signMessage: await other.signMessage(text) })
	expect(voiceCallHandlesEndedInBatch([forged]).size).toBe(0)
})
