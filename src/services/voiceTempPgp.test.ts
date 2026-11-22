/**
 * @jest-environment node
 */
import { fingerprintOfPublicArmor, forgetTemporaryPgpKey, newTemporaryPgpKey, tempPgpArmorMatchesFingerprint } from '../../vendor/conet-chat-sdk/dist/voice-temp-pgp.js'

describe('per-call temporary PGP key', () => {
	test('a new key has a 40-hex lower-case fingerprint that matches its public armor', async () => {
		const k = await newTemporaryPgpKey()
		expect(k.fingerprint).toMatch(/^[0-9a-f]{40}$/)
		expect(await fingerprintOfPublicArmor(k.publicArmor)).toBe(k.fingerprint)
		expect(k.publicArmor).toContain('BEGIN PGP PUBLIC KEY BLOCK')
	})

	test('two calls produce different keys (never reused)', async () => {
		const a = await newTemporaryPgpKey()
		const b = await newTemporaryPgpKey()
		expect(a.fingerprint).not.toBe(b.fingerprint)
		expect(a.privateArmor).not.toBe(b.privateArmor)
	})

	test('the public armor carries no private key material', async () => {
		const k = await newTemporaryPgpKey()
		expect(k.publicArmor).not.toContain('PRIVATE KEY')
	})

	test('forgetting clears the held private armor', async () => {
		const k = await newTemporaryPgpKey()
		forgetTemporaryPgpKey(k)
		expect(k.privateArmor).toBe('')
	})

	test('case K: the armor fingerprint must equal the signed tempPgpFpr, character for character', async () => {
		const k = await newTemporaryPgpKey()
		expect(await tempPgpArmorMatchesFingerprint(k.publicArmor, k.fingerprint)).toBe(true)
		expect(await tempPgpArmorMatchesFingerprint(k.publicArmor, k.fingerprint.toUpperCase())).toBe(false)
		expect(await tempPgpArmorMatchesFingerprint(k.publicArmor, 'c'.repeat(40))).toBe(false)
		expect(await tempPgpArmorMatchesFingerprint(undefined, '')).toBe(true)
		expect(await tempPgpArmorMatchesFingerprint(undefined, 'c'.repeat(40))).toBe(false)
	})
})
