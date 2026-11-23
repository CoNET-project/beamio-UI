/**
 * @jest-environment node
 */
import { ethers } from 'ethers'
import { webcrypto } from 'crypto'
import { forgetCallerV4Channel, newCallerV4Channel, signOfferV4, verifyOfferV4 } from '../../vendor/conet-chat-sdk/dist/voice-v4-offer.js'
import { newTemporaryPgpKey } from '../../vendor/conet-chat-sdk/dist/voice-temp-pgp.js'
import { newVoiceChannelSecrets, newTemporaryChannelWallet, signVoiceAuth } from '../../vendor/conet-chat-sdk/dist/voice-v3.js'

// The jest node sandbox may not expose the global Web Crypto used by the SDK's CSPRNG helpers.
if (!(globalThis as { crypto?: unknown }).crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto

const CALLER = new ethers.Wallet('0x' + '11'.repeat(32))
const CALLEE = '0x2222222222222222222222222222222222222222'
const signer = { address: CALLER.address, signMessage: (m: string) => CALLER.signMessage(m) }
const NOW = 1800000000000
const EXP = NOW + 900_000

async function makeOffer() {
	const base = { callId: 'call-1', sessionId: 'sess-1', to: CALLEE, createdAt: NOW, expiresAt: EXP, timestamp: NOW, codec: 'audio/pcm;rate=16000' }
	const cv = await newCallerV4Channel(signer, { callId: base.callId, sessionId: base.sessionId, label: 'cv', validUntil: EXP })
	const cV = await newCallerV4Channel(signer, { callId: base.callId, sessionId: base.sessionId, label: 'cV', validUntil: EXP })
	const s = await signOfferV4(signer, base, cv.public, cV.public)
	return { offer: { ...base, from: s.from, sig: s.sig, cv: cv.public, cV: cV.public }, cv, cV }
}

describe('caller v4 offer (v101 §108.2–108.4, §108.7)', () => {
	test('a fresh offer verifies for the callee account', async () => {
		const { offer } = await makeOffer()
		expect(await verifyOfferV4(offer, CALLEE, NOW)).toBe(true)
	})

	test('the two channels have separate temporary wallets and PGP keys', async () => {
		const { cv, cV } = await makeOffer()
		expect(cv.public.temp).not.toBe(cV.public.temp)
		expect(cv.public.tempPgpFpr).not.toBe(cV.public.tempPgpFpr)
		expect(cv.public.tempPgpArmor).toContain('BEGIN PGP PUBLIC KEY BLOCK')
	})

	test('the offer carries no private key material', async () => {
		const { offer, cv } = await makeOffer()
		const wire = JSON.stringify(offer)
		expect(wire).not.toContain(cv.secret.tempPrivateKey)
		expect(wire).not.toContain('PRIVATE KEY')
	})

	test('an offer addressed to another account is refused', async () => {
		const { offer } = await makeOffer()
		expect(await verifyOfferV4(offer, '0x3333333333333333333333333333333333333333', NOW)).toBe(false)
	})

	test('a changed channel (sid) breaks the chansDigest and is refused', async () => {
		const { offer } = await makeOffer()
		expect(await verifyOfferV4({ ...offer, cv: { ...offer.cv, sid: 'tampered' } }, CALLEE, NOW)).toBe(false)
	})

	test('a fingerprint that does not match the armor is refused', async () => {
		const { offer } = await makeOffer()
		const bad = { ...offer.cv, tempPgpFpr: 'b'.repeat(40) }
		expect(await verifyOfferV4({ ...offer, cv: bad }, CALLEE, NOW)).toBe(false)
	})

	test('an expired offer is refused', async () => {
		const { offer } = await makeOffer()
		expect(await verifyOfferV4(offer, CALLEE, EXP + 1)).toBe(false)
	})

	test('forgetting a caller channel clears its temporary wallet key and PGP private key', async () => {
		const { cv } = await makeOffer()
		forgetCallerV4Channel(cv)
		expect(cv.secret.tempPrivateKey).toBe('')
		expect(cv.secret.pgp.privateArmor).toBe('')
	})

	// Probe 5 (review K-closure): the signed fingerprint is fp1 but the armor is key 2 -> refused.
	test('probe 5: an authorization signed for fp1 with the armor of key 2 is refused (the top-level field and the armor must both match the signed value)', async () => {
		const k1 = await newTemporaryPgpKey()
		const k2 = await newTemporaryPgpKey()
		const mk = async (label: 'cv' | 'cV', sid: string, fpr: string, armor: string) => {
			const sec = newVoiceChannelSecrets()
			const w = newTemporaryChannelWallet()
			const auth = await signVoiceAuth(signer, { callId: 'call-1', sessionId: 'sess-1', channel: label, temp: w.address, tempPgpFpr: fpr, validUntil: EXP })
			return { sid: sec.sid, key: sec.key, wk: sec.wk, temp: w.address.toLowerCase(), tempPgpFpr: fpr, tempPgpArmor: armor, auth }
		}
		const cv = await mk('cv', 's1', k1.fingerprint, k2.publicArmor)
		const cV = await mk('cV', 's2', k1.fingerprint, k2.publicArmor)
		const base = { callId: 'call-1', sessionId: 'sess-1', to: CALLEE, createdAt: NOW, expiresAt: EXP, timestamp: NOW, codec: 'audio/pcm;rate=16000' }
		const s2 = await signOfferV4(signer, base, cv, cV)
		expect(await verifyOfferV4({ ...base, from: s2.from, sig: s2.sig, cv, cV }, CALLEE, NOW)).toBe(false)
	})

	// Probe 6: an upper-case fingerprint is refused (no case normalisation), even when it matches the armor in lower case.
	test('probe 6: an upper-case tempPgpFpr is refused', async () => {
		const k = await newTemporaryPgpKey()
		const mk = async (label: 'cv' | 'cV', sid: string) => {
			const sec = newVoiceChannelSecrets()
			const w = newTemporaryChannelWallet()
			const upper = k.fingerprint.toUpperCase()
			const auth = await signVoiceAuth(signer, { callId: 'call-1', sessionId: 'sess-1', channel: label, temp: w.address, tempPgpFpr: upper, validUntil: EXP })
			return { sid: sec.sid, key: sec.key, wk: sec.wk, temp: w.address.toLowerCase(), tempPgpFpr: upper, tempPgpArmor: k.publicArmor, auth }
		}
		const cv = await mk('cv', 'a')
		const cV = await mk('cV', 'b')
		const base = { callId: 'call-1', sessionId: 'sess-1', to: CALLEE, createdAt: NOW, expiresAt: EXP, timestamp: NOW, codec: 'audio/pcm;rate=16000' }
		const s2 = await signOfferV4(signer, base, cv, cV)
		expect(await verifyOfferV4({ ...base, from: s2.from, sig: s2.sig, cv, cV }, CALLEE, NOW)).toBe(false)
	})

	test('a missing top-level tempPgpFpr drops the offer silently (no TypeError)', async () => {
		const { offer } = await makeOffer()
		const { tempPgpFpr: _drop, ...noFpr } = offer.cv
		await expect(verifyOfferV4({ ...offer, cv: noFpr as never }, CALLEE, NOW)).resolves.toBe(false)
		await expect(verifyOfferV4({ ...offer, cV: { ...offer.cV, tempPgpFpr: undefined } as never }, CALLEE, NOW)).resolves.toBe(false)
	})
})
