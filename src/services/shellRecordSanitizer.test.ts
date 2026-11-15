/**
 * (plan N): the page-side sanitizer for records that cross the native bridge. The EOA is kept, the PGP private fields are
 * removed from a copy, and the assertion refuses a payload that still has one.
 */
import { assertNoPgpPrivate, eoaPrivateKeyPresent, pgpPrivatePaths, pgpPublicPaths, sanitizeForBridge, stripPgpPublicFromBeamio, stripWalletFields, utf8ByteLength, walletCopyPaths, withoutPeerPublicArmor } from './shellRecordSanitizer'

const PGP = 'PGP-PRIV-ARMOR-XYZ'
const record = () => ({
	mnemonicPhrase: 'w w w',
	pgpPassphrase: 'x',
	profiles: [
		[{ keyID: '0x' + '1'.repeat(40), privateKeyArmor: '0x' + '2'.repeat(64), chatManager: { pgpKey: { keyID: 'K', publicKey: 'PUB', privateKey: PGP, privateKeyArmor: PGP } } }],
		{ keyID: '0x' + '3'.repeat(40), pgpKey: { publicKey: 'PUB2', privateKeyArmorWrap: { ct: PGP } } },
	],
})

describe('shell record sanitizer (plan N)', () => {
	it('lists the PGP private paths without any value', () => {
		const paths = pgpPrivatePaths(record())
		expect(paths).toEqual(
			expect.arrayContaining([
				'profiles[].chatManager.pgpKey.privateKey',
				'profiles[].chatManager.pgpKey.privateKeyArmor',
				'profiles[].pgpKey.privateKeyArmorWrap',
				'pgpPassphrase',
			]),
		)
		expect(JSON.stringify(paths).includes(PGP)).toBe(false)
	})

	it('the copy has no PGP private field and keeps the public key, the key id and the EOA key', () => {
		const out: any = sanitizeForBridge(record())
		expect(JSON.stringify(out).includes(PGP)).toBe(false)
		expect(out.profiles[0][0].chatManager.pgpKey.publicKey).toBe('PUB')
		expect(out.profiles[0][0].chatManager.pgpKey.keyID).toBe('K')
		expect(out.profiles[0][0].privateKeyArmor).toBe('0x' + '2'.repeat(64))
		expect(out.mnemonicPhrase).toBe('w w w')
		expect(out.pgpPassphrase).toBeUndefined()
	})

	it('the input is not changed (no shared references with the caller)', () => {
		const input = record()
		sanitizeForBridge(input)
		expect(JSON.stringify(input).includes(PGP)).toBe(true)
	})

	it('the assertion refuses a payload with a PGP private field and passes a sanitized one', () => {
		expect(() => assertNoPgpPrivate(record())).toThrow(/pgp_private_in_payload/)
		expect(() => assertNoPgpPrivate(sanitizeForBridge(record()))).not.toThrow()
	})
})

describe('shell record sanitizer, additions (8, .5)', () => {
	it('the chat private armor path is refused and removed from the copy', () => {
		const rec = { profiles: [{ keyID: 'k', chats: [{ chatData: { privateArmored: 'X', publicArmored: 'P' } }] }] }
		expect(pgpPrivatePaths(rec)).toEqual(['profiles[].chats[].chatData.privateArmored'])
		const out: any = sanitizeForBridge(rec)
		expect(out.profiles[0].chats[0].chatData.privateArmored).toBeUndefined()
		expect(out.profiles[0].chats[0].chatData.publicArmored).toBe('P')
	})

	it('the PGP header in any string value is refused (the header is not returned)', () => {
		// TEST ONLY: the string below is a detector input (a header only). It contains no key material.
		expect(() => assertNoPgpPrivate({ note: 'BEGIN PGP PRIVATE KEY BLOCK' })).toThrow(/pgp_private_in_payload/)
		expect(() => assertNoPgpPrivate({ note: 'public only' })).not.toThrow()
	})

	it('the W-class paths are listed (paths only); the mnemonic is mnemonicPhrase', () => {
		expect(walletCopyPaths({ profiles: [{ privateKeyArmor: '0x' }], mnemonicPhrase: 'x' })).toEqual(['profiles[].privateKeyArmor', 'mnemonicPhrase'])
		expect(walletCopyPaths({ profiles: [{ keyID: 'k' }] })).toEqual([])
	})

	it('pgpPublicPaths lists the PGP public containers (paths only)', () => {
		const input = { profiles: [{ chatManager: { pgpKey: { publicKey: 'P', keyID: 'K' }, router: 'r' } }, { pgpKey: { keyID: 'K2' } }] }
		expect(pgpPublicPaths(input)).toEqual(['profiles[].chatManager.pgpKey', 'profiles[].pgpKey'])
		expect(pgpPublicPaths({ profiles: [{ chatManager: { router: 'r' } }] })).toEqual([])
	})

	it('.2: stripWalletFields removes the W-class fields from a copy and keeps the input', () => {
		const input = { profiles: [{ keyID: 'k', privateKeyArmor: '0x2', privateKeyArmorWrap: { ct: 'x' } }], walletVault: { mnemonic: 'm', x: 1 }, mnemonic: 'm' }
		const out: any = stripWalletFields(input)
		expect(out).toEqual({ profiles: [{ keyID: 'k' }], walletVault: { x: 1 } })
		expect(input.profiles[0].privateKeyArmor).toBe('0x2')
	})

	it('the page record mnemonic (mnemonicPhrase) is a W-class field: listed and never sent in a write copy', () => {
		expect(walletCopyPaths({ profiles: [], mnemonicPhrase: 'w w' })).toEqual(['mnemonicPhrase'])
		const out: any = stripWalletFields({ profiles: [{ keyID: 'k' }], mnemonicPhrase: 'w w', rev: 1 })
		expect(out).toEqual({ profiles: [{ keyID: 'k' }], rev: 1 })
	})

	it('recoveryWords is a W-class secret: listed and never sent in a write copy', () => {
		expect(walletCopyPaths({ profiles: [], recoveryWords: 'a b' })).toEqual(['recoveryWords'])
		const out: any = stripWalletFields({ profiles: [{ keyID: 'k' }], recoveryWords: 'a b', rev: 1 })
		expect(out).toEqual({ profiles: [{ keyID: 'k' }], rev: 1 })
	})

	it('the account beamio PGP public fields are listed as PGP public (paths only)', () => {
		expect(pgpPublicPaths({ profiles: [], beamio: { accountName: 'a', pgpPublicKeyArmor: 'ARM', pgpPublicKeyID: 'K' } })).toEqual([
			'beamio.pgpPublicKeyID',
			'beamio.pgpPublicKeyArmor',
		])
		expect(pgpPublicPaths({ profiles: [], beamio: { accountName: 'a' } })).toEqual([])
	})

	it('stripPgpPublicFromBeamio drops the PGP public fields of the account copy and keeps the input', () => {
		const b = { accountName: 'a', pgpPublicKeyArmor: 'ARM', pgpPublicKeyID: 'K' }
		expect(stripPgpPublicFromBeamio(b)).toEqual({ accountName: 'a' })
		expect(b.pgpPublicKeyArmor).toBe('ARM')
	})

	it('(scheme A): eoaPrivateKeyPresent needs the EOA key, not the mnemonic', () => {
		expect(eoaPrivateKeyPresent({ profiles: [{ privateKeyArmor: '0x2' }] })).toBe(true)
		expect(eoaPrivateKeyPresent({ profiles: [{ keyID: 'k' }], mnemonicPhrase: 'w w w' })).toBe(false)
		expect(eoaPrivateKeyPresent({ profiles: [{ privateKeyArmor: '' }] })).toBe(false)
	})

	it('utf8ByteLength counts bytes, not characters', () => {
		expect(utf8ByteLength('abc')).toBe(3)
		expect(utf8ByteLength('é')).toBe(2)
		expect(utf8ByteLength('中')).toBe(3)
		expect(utf8ByteLength('😀')).toBe(4)
	})
	it('a chat peer publicArmored is refused on a page write (path only); the receive copy drops it', () => {
		const rec = { profiles: [{ keyID: '0x' + '4'.repeat(40), chats: [{ chatData: { publicArmored: 'PEER-PUB-VALUE', text: 'hi' } }] }] }
		const paths = pgpPublicPaths(rec)
		expect(paths).toEqual(['profiles[].chats[].chatData.publicArmored'])
		expect(JSON.stringify(paths)).not.toContain('PEER-PUB-VALUE')
		expect(withoutPeerPublicArmor(rec.profiles[0].chats[0].chatData)).toEqual({ text: 'hi' })
		// The input is not changed by the copy.
		expect(rec.profiles[0].chats[0].chatData.publicArmored).toBe('PEER-PUB-VALUE')
	})
})
