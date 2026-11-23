/**
 * @jest-environment node
 *
 * Alternative A (v78 §85, v80 §87): temporary channel wallets are CSPRNG-generated per channel and per call; the message carries
 * only the address and the user EOA's authorization. Real EIP-191 signatures with throwaway wallets (nothing stored).
 */
import { Wallet } from 'ethers'
import {
	newTemporaryChannelWallet,
	signVoiceAuth,
	verifyVoiceAuth,
	verifyVoicePayFor,
	voicePayText,
	voiceAuthText,
	type VoiceChannelAuth,
} from '../../vendor/conet-chat-sdk/dist/voice-v3.js'

const f = (over: Record<string, unknown> = {}) => ({
	callId: 'c-alt-1',
	sessionId: 's-alt-1',
	channel: 'cv' as const,
	temp: Wallet.createRandom().address,
	tempPgpFpr: '',
	validUntil: Date.now() + 3600_000,
	...over,
})

describe('temporary channel wallets (CSPRNG, per channel)', () => {
	test('two calls produce different temporary addresses', () => {
		const a = newTemporaryChannelWallet()
		const b = newTemporaryChannelWallet()
		expect(a.address).not.toBe(b.address)
		expect(a.privateKey).not.toBe(b.privateKey)
	})
	test('the generated wallet is consistent: the address is the one of the private key', () => {
		const a = newTemporaryChannelWallet()
		expect(new Wallet(a.privateKey).address).toBe(a.address)
	})
})

describe('auth canonical (v77 §84.3, lower-case, byte for byte)', () => {
	test('the text has the fixed prefix and lower-case addresses', () => {
		const text = voiceAuthText({ callId: 'C', sessionId: 'S', channel: 'ev', temp: '0xABCDEF0000000000000000000000000000000001', tempPgpFpr: '', from: '0xAbC0000000000000000000000000000000000002', validUntil: 99 })
		expect(text).toBe('CoNET voice_pgp_auth_v1\ncallId:C\nsessionId:S\nchannel:ev\ntemp:0xabcdef0000000000000000000000000000000001\ntempPgpFpr:\nfrom:0xabc0000000000000000000000000000000000002\nvalidUntil:99')
	})
})

describe('auth sign and verify', () => {
	test('an auth with a field beyond {from, validUntil, sig} is refused (v111 §128)', async () => {
		const user = Wallet.createRandom()
		const fields = f()
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth({ ...auth, tempPgpFpr: '' } as never, fields, user.address)).toBe(false)
	})

	test('a non-empty fingerprint that is not lower-case 40-hex is refused', async () => {
		const user = Wallet.createRandom()
		const fields = f({ tempPgpFpr: 'A'.repeat(40) })
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, fields, user.address)).toBe(false)
	})

	test('a valid authorization by the channel user EOA verifies', async () => {
		const user = Wallet.createRandom()
		const fields = f()
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, fields, user.address)).toBe(true)
	})
	test('an authorization by another EOA does not verify', async () => {
		const user = Wallet.createRandom()
		const other = Wallet.createRandom()
		const fields = f()
		const auth = await signVoiceAuth(other, fields)
		expect(verifyVoiceAuth(auth, fields, user.address)).toBe(false)
	})
	test('a changed callId, sessionId, channel or temp address does not verify', async () => {
		const user = Wallet.createRandom()
		const fields = f()
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, { ...fields, callId: 'other' }, user.address)).toBe(false)
		expect(verifyVoiceAuth(auth, { ...fields, sessionId: 'other' }, user.address)).toBe(false)
		expect(verifyVoiceAuth(auth, { ...fields, channel: 'eV' }, user.address)).toBe(false)
		expect(verifyVoiceAuth(auth, { ...fields, temp: Wallet.createRandom().address }, user.address)).toBe(false)
	})
	test('an expired authorization does not verify (ms)', async () => {
		const user = Wallet.createRandom()
		const fields = f({ validUntil: Date.now() - 1 })
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, fields, user.address)).toBe(false)
	})
	test('validUntil in seconds would be refused: the check is in milliseconds', async () => {
		const user = Wallet.createRandom()
		const fields = f({ validUntil: Math.floor(Date.now() / 1000) + 3600 })
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, fields, user.address)).toBe(false)
	})
	test('validUntil later than the offer expiresAt (ms) is refused; equal is accepted', async () => {
		const user = Wallet.createRandom()
		const now = Date.now()
		const fields = f({ validUntil: now + 600_000 })
		const auth = await signVoiceAuth(user, fields)
		expect(verifyVoiceAuth(auth, fields, user.address, now, now + 500_000)).toBe(false)
		expect(verifyVoiceAuth(auth, fields, user.address, now, now + 600_000)).toBe(true)
	})
	test('a changed validUntil does not verify (the signed value is authoritative)', async () => {
		const user = Wallet.createRandom()
		const fields = f()
		const auth = await signVoiceAuth(user, fields)
		const tampered: VoiceChannelAuth = { ...auth, validUntil: auth.validUntil + 60 }
		expect(verifyVoiceAuth(tampered, fields, user.address)).toBe(false)
	})
	test('a missing or malformed authorization is refused', () => {
		const user = Wallet.createRandom()
		expect(verifyVoiceAuth(null, f(), user.address)).toBe(false)
		expect(verifyVoiceAuth({ from: user.address, validUntil: 9e9, sig: '0x' } as VoiceChannelAuth, f(), user.address)).toBe(false)
	})
})

describe('pay for a temporary address (signed by the callee EOA)', () => {
	test('a pay signed by the expected payer for this temp address verifies', async () => {
		const payer = Wallet.createRandom()
		const temp = Wallet.createRandom().address
		const notAfter = Math.floor(Date.now() / 1000) + 3600
		const sig = await payer.signMessage(voicePayText(temp, notAfter, 0, 0))
		const pay = { payer: payer.address.toLowerCase(), notAfter, maxBytes: 0, maxSeconds: 0, sig }
		expect(verifyVoicePayFor(pay, temp, payer.address)).toBe(true)
	})
	test('a pay for another temp address, another payer, or an expired notAfter is refused', async () => {
		const payer = Wallet.createRandom()
		const temp = Wallet.createRandom().address
		const notAfter = Math.floor(Date.now() / 1000) + 3600
		const sig = await payer.signMessage(voicePayText(temp, notAfter, 0, 0))
		const pay = { payer: payer.address.toLowerCase(), notAfter, maxBytes: 0, maxSeconds: 0, sig }
		expect(verifyVoicePayFor(pay, Wallet.createRandom().address, payer.address)).toBe(false)
		expect(verifyVoicePayFor(pay, temp, Wallet.createRandom().address)).toBe(false)
		expect(verifyVoicePayFor({ ...pay, notAfter: Math.floor(Date.now() / 1000) - 1 }, temp, payer.address)).toBe(false)
	})
})
