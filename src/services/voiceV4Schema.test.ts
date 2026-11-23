import { acceptV4SchemaOk, offerV4SchemaOk, payV4SchemaOk, rejectReasonOk } from './voiceV4Schema'

const AUTH = { from: '0x' + '11'.repeat(20), validUntil: 1800000900000, sig: '0x' + 'ab'.repeat(65) }
const CH = { sid: 'a'.repeat(32), key: 'k=', wk: 'w=', temp: '0x' + '22'.repeat(20), tempPgpFpr: 'c'.repeat(40), tempPgpArmor: '-----BEGIN PGP PUBLIC KEY BLOCK-----', auth: AUTH }
const OFFER = { type: 'voice_call_offer_v1', proto: 4, callId: 'call-1', sessionId: 'sess-1', from: '0x' + '11'.repeat(20), to: '0x' + '33'.repeat(20), codec: 'audio/pcm;rate=16000', createdAt: 1, expiresAt: 2, timestamp: 1, cv: CH, cV: CH, sig: '0x' + 'cd'.repeat(65) }
const PAY = { role: 'cv', temp: '0x' + '22'.repeat(20), notAfter: 1800003600, maxBytes: 0, maxSeconds: 0, sig: '0x' + 'ef'.repeat(65) }
const ACCEPT = { type: 'voice_call_accept_v1', proto: 4, callId: 'call-1', sessionId: 'sess-1', from: '0x' + '33'.repeat(20), to: '0x' + '11'.repeat(20), createdAt: 1, expiresAt: 2, ev: CH, eV: CH, cv_pay: PAY, cV_pay: { ...PAY, role: 'cV' }, ev_pay: { ...PAY, role: 'ev' }, eV_pay: { ...PAY, role: 'eV' }, sig: '0x' + 'cd'.repeat(65) }

describe('v4 key schema (v122 §141)', () => {
	test('a well-formed offer v4 and accept v4 pass', () => {
		expect(offerV4SchemaOk(OFFER)).toBe(true)
		expect(acceptV4SchemaOk(ACCEPT)).toBe(true)
	})

	test('an offer v4 with callerTag, callerPgp, callerRoute or callerSignature is refused', () => {
		for (const k of ['callerTag', 'callerPgp', 'callerRoute', 'callerSignature']) {
			expect(offerV4SchemaOk({ ...OFFER, [k]: 'x' })).toBe(false)
		}
	})

	test('an accept v4 with codec or timestamp is refused', () => {
		expect(acceptV4SchemaOk({ ...ACCEPT, codec: 'audio/pcm;rate=16000' })).toBe(false)
		expect(acceptV4SchemaOk({ ...ACCEPT, timestamp: 1 })).toBe(false)
	})

	test('a pay with a payer key is refused; the six keys are exact', () => {
		expect(payV4SchemaOk(PAY)).toBe(true)
		expect(payV4SchemaOk({ ...PAY, payer: '0x' + '33'.repeat(20) })).toBe(false)
		const { maxSeconds: _m, ...noMax } = PAY
		expect(payV4SchemaOk(noMax)).toBe(false)
	})

	test('an auth with a field beyond from, validUntil, sig is refused inside a channel', () => {
		expect(offerV4SchemaOk({ ...OFFER, cv: { ...CH, auth: { ...AUTH, tempPgpFpr: 'c'.repeat(40) } } })).toBe(false)
	})

	test('the reject reason is declined or busy only', () => {
		expect(rejectReasonOk('declined')).toBe(true)
		expect(rejectReasonOk('busy')).toBe(true)
		expect(rejectReasonOk('timeout')).toBe(false)
		expect(rejectReasonOk(undefined)).toBe(false)
	})
})
