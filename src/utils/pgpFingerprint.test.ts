/**
 * @jest-environment node
 */
/**
 * (non-blocking): the OpenPGP fingerprint, its display, and the stored scheme of the baseline. A value stored by
 * an earlier build (an armor SHA-256, no scheme) is no baseline. SYNTHETIC keys generated here.
 */
import { generateKey } from 'openpgp'
import { formatFingerprintForCompare, openPgpFingerprintOfArmor, readStoredKeyFingerprint, storedKeyFingerprint } from './pgpFingerprint'

let KEY = ''
let OTHER = ''

beforeAll(async () => {
	KEY = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'fp' }], format: 'armored' })).publicKey.trim()
	OTHER = (await generateKey({ type: 'curve25519', userIDs: [{ name: 'other' }], format: 'armored' })).publicKey.trim()
}, 60_000)

describe('openPgpFingerprintOfArmor: the OpenPGP standard fingerprint', () => {
	it('is lowercase hex of 40 characters for a v4 key, the same for the same key with other line endings', async () => {
		const fp = await openPgpFingerprintOfArmor(KEY)
		expect(fp).toMatch(/^[0-9a-f]{40}$/)
		expect(await openPgpFingerprintOfArmor(KEY.replace(/\n/g, '\r\n'))).toBe(fp)
	})

	it('differs for a different key', async () => {
		expect(await openPgpFingerprintOfArmor(OTHER)).not.toBe(await openPgpFingerprintOfArmor(KEY))
	})
})

describe('formatFingerprintForCompare: the comparison view', () => {
	it('groups the fingerprint in fours, in upper case', () => {
		expect(formatFingerprintForCompare('abcd1234ef')).toBe('ABCD 1234 EF')
	})
})

describe('the stored baseline carries its scheme', () => {
	it('a value written with the scheme reads back as the fingerprint', () => {
		const fp = 'a'.repeat(40)
		expect(readStoredKeyFingerprint(storedKeyFingerprint(fp))).toBe(fp)
	})

	it('a value stored by an earlier build (an armor SHA-256, no scheme) is no baseline', () => {
		expect(readStoredKeyFingerprint('f'.repeat(64))).toBeUndefined()
		expect(readStoredKeyFingerprint('')).toBeUndefined()
		expect(readStoredKeyFingerprint(undefined)).toBeUndefined()
	})

	it('a value with the scheme but not a fingerprint is no baseline', () => {
		expect(readStoredKeyFingerprint('openpgp:not-hex')).toBeUndefined()
	})
})
