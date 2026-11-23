/**
 * @jest-environment node
 */
import { ethers } from 'ethers'
import { acceptV4Text, armorSha256, chansDigest, offerV4Text, payDigest, type V4Channel } from '../../vendor/conet-chat-sdk/dist/voice-v4.js'

const sha = (t: string) => ethers.sha256(ethers.toUtf8Bytes(t)).slice(2).toLowerCase()
const ARMOR = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----'
const FPR = 'a'.repeat(40)
const ch = (over: Partial<V4Channel> = {}): V4Channel => ({
	sid: 'SID1', key: 'KEY1', wk: 'WK1', temp: '0xABCDEF0000000000000000000000000000000001', tempPgpFpr: FPR, tempPgpArmor: ARMOR,
	auth: { from: '0x1111111111111111111111111111111111111111', validUntil: 1800000900000, sig: '0x00' },
	...over,
})

describe('voice protocol v4 digests and canonical texts (v101 §108)', () => {
	test('armorSha256 is empty without armor and the SHA-256 hex of the UTF-8 armor otherwise', () => {
		expect(armorSha256(undefined)).toBe('')
		expect(armorSha256(ARMOR)).toBe(sha(ARMOR))
	})

	test('chansDigest is SHA-256 of the per-channel lines, \\n joined, no trailing newline', () => {
		const a = ch()
		const b = ch({ sid: 'SID2', tempPgpArmor: undefined, tempPgpFpr: '' })
		const expected = [
			`role:cv sid:SID1 key:KEY1 wk:WK1 temp:0xabcdef0000000000000000000000000000000001 tempPgpFpr:${FPR} armorSha256:${sha(ARMOR)}`,
			`role:cV sid:SID2 key:KEY1 wk:WK1 temp:0xabcdef0000000000000000000000000000000001 tempPgpFpr: armorSha256:`,
		].join('\n')
		expect(chansDigest(['cv', 'cV'], [a, b])).toBe(sha(expected))
	})

	test('a channel without user-side PGP keeps an empty fingerprint and an empty armor digest', () => {
		const t = chansDigest(['ev', 'eV'], [ch({ tempPgpArmor: undefined, tempPgpFpr: '' }), ch({ tempPgpArmor: undefined, tempPgpFpr: '' })])
		expect(t).toMatch(/^[0-9a-f]{64}$/)
	})

	test('payDigest orders lines as given and uses notAfter in seconds', () => {
		const pays = [
			{ role: 'cv' as const, temp: '0xAA00000000000000000000000000000000000001', notAfter: 1800003600, maxBytes: 1000, maxSeconds: 60, sig: '0xs1' },
			{ role: 'cV' as const, temp: '0xAA00000000000000000000000000000000000002', notAfter: 1800003600, maxBytes: 2000, maxSeconds: 120, sig: '0xs2' },
		]
		const expected = [
			'role:cv temp:0xaa00000000000000000000000000000000000001 notAfter:1800003600 maxBytes:1000 maxSeconds:60 sig:0xs1',
			'role:cV temp:0xaa00000000000000000000000000000000000002 notAfter:1800003600 maxBytes:2000 maxSeconds:120 sig:0xs2',
		].join('\n')
		expect(payDigest(pays)).toBe(sha(expected))
	})

	test('offer v4 canonical: timestamp equals createdAt, from and to lower-case, exact layout', () => {
		const text = offerV4Text({ callId: 'C', sessionId: 'S', from: '0xAbC0000000000000000000000000000000000001', to: '0xDEF0000000000000000000000000000000000002', createdAt: 100, expiresAt: 200, codec: 'audio/pcm;rate=16000', chansDigest: 'd'.repeat(64) })
		expect(text).toBe([
			'CoNET voice_call_offer_v4', 'callId:C', 'sessionId:S',
			'from:0xabc0000000000000000000000000000000000001', 'to:0xdef0000000000000000000000000000000000002',
			'createdAt:100', 'expiresAt:200', 'timestamp:100', 'codec:audio/pcm;rate=16000', `chansDigest:${'d'.repeat(64)}`,
		].join('\n'))
	})

	test('accept v4 canonical hashes the offer sig text and keeps the expiresAt of the offer', () => {
		const text = acceptV4Text({ callId: 'C', sessionId: 'S', from: '0xDEF0000000000000000000000000000000000002', to: '0xAbC0000000000000000000000000000000000001', offerSig: '0xABCD', chansDigest: 'c'.repeat(64), payDigest: 'p'.repeat(64), createdAt: 150, expiresAt: 200 })
		expect(text.split('\n')[5]).toBe(`offerSigSha256:${sha('0xabcd')}`)
		expect(text.split('\n')[0]).toBe('CoNET voice_call_accept_v4')
		expect(text.endsWith('expiresAt:200')).toBe(true)
	})
})
