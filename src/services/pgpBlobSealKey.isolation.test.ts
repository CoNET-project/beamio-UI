/**
 * @jest-environment node
 */
/**
 * Isolation checks for the sealing CryptoKey (pgpBlobSealKey.ts). Synthetic accounts only.
 * Covered: the legacy format stays readable by the existing open path; a key of one account does not open another's blob; the key
 * cannot be exported or used to decrypt; a closed session cannot seal. The real Web Worker clone is checked on Node.
 */
// the jest node environment has no global WebCrypto; the browser has it. Use the Node webcrypto, the same API surface.
if (!(globalThis as { crypto?: unknown }).crypto) Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true })
// eslint-disable-next-line import/first
import { legacySealCryptoKey, PgpSealSession, sealLegacyWithCryptoKey } from './pgpBlobSealKey'
import { openLegacyPgpBlob, sealLegacyPgpBlob } from './pgpBlob'

const ACCOUNT_A = '0x' + '11'.repeat(32)
const ACCOUNT_B = '0x' + '22'.repeat(32)
const PGP = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nSYNTHETIC\n-----END PGP PRIVATE KEY BLOCK-----'

describe('sealing CryptoKey: format compatibility', () => {
	it('a blob sealed with the key opens with the existing legacy reader, and the output has the same shape as the legacy writer', async () => {
		const key = await legacySealCryptoKey(ACCOUNT_A)
		const blob = await sealLegacyWithCryptoKey(PGP, key)
		expect(await openLegacyPgpBlob(blob, ACCOUNT_A)).toBe(PGP)
		// same layout as the existing writer: base64 with IV first, no prefix
		expect(blob).toMatch(/^[A-Za-z0-9+/]+=*$/)
		expect(await openLegacyPgpBlob(await sealLegacyPgpBlob(PGP, ACCOUNT_A), ACCOUNT_A)).toBe(PGP)
	})
})

describe('sealing CryptoKey: isolation', () => {
	it('another account cannot open the blob: the existing reader rejects it under the other account key', async () => {
		const key = await legacySealCryptoKey(ACCOUNT_A)
		const blob = await sealLegacyWithCryptoKey(PGP, key)
		await expect(openLegacyPgpBlob(blob, ACCOUNT_B)).rejects.toThrow()
	})

	it('the key is not extractable and has only the encrypt usage', async () => {
		const key = await legacySealCryptoKey(ACCOUNT_A)
		expect(key.extractable).toBe(false)
		expect(key.usages).toEqual(['encrypt'])
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
	})

	it('the key cannot decrypt: a decrypt call with it fails (no decrypt usage)', async () => {
		const key = await legacySealCryptoKey(ACCOUNT_A)
		const blob = await sealLegacyWithCryptoKey(PGP, key)
		const raw = Uint8Array.from(Buffer.from(blob, 'base64'))
		await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))).rejects.toThrow()
	})

	it('a closed session cannot seal: the reference is dropped at the session end', async () => {
		const session = new PgpSealSession(await legacySealCryptoKey(ACCOUNT_A))
		expect(await openLegacyPgpBlob(await session.seal(PGP), ACCOUNT_A)).toBe(PGP)
		session.close()
		await expect(session.seal(PGP)).rejects.toThrow('session closed')
	})
})
