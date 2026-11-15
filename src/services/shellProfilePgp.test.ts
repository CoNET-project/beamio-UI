/**
 * Boundary: in a shell the PGP private key is removed from the page copy at any depth (the Chat SDK
 * alone holds it). The EOA key material stays with the page as before, so it is NOT stripped here.
 */
import { accountAddressOf, keepStoredPgpSecrets, pgpSecretsKeptForDisk, stripShellSecrets } from './shellProfile'

describe('stripShellSecrets: PGP only', () => {
	it('removes the PGP private key fields at any depth, including nested arrays', () => {
		const tree = {
			profiles: [
				[{ keyID: '0x' + '1'.repeat(40), pgpKey: { keyID: 'K1', publicKey: 'PUB', privateKey: 'P1', privateKeyArmor: 'P2' } }],
				{ keyID: '0x' + '2'.repeat(40), chatManager: { pgpKey: { publicKey: 'PUB2', privateKey: 'P3' } } },
			],
		}
		const out = stripShellSecrets(tree) as typeof tree
		const text = JSON.stringify(out)
		expect(text).not.toContain('"P1"')
		expect(text).not.toContain('"P2"')
		expect(text).not.toContain('"P3"')
		expect(text).toContain('"PUB"')
		expect(text).toContain('"PUB2"')
	})

	it('keeps the EOA key material the page owns (boundary: the PWA keeps its EOA)', () => {
		const tree = { profiles: [{ keyID: '0x' + '1'.repeat(40), privateKeyArmor: '0xabc', mnemonicPhrase: 'w w w' }] }
		const out = stripShellSecrets(tree) as typeof tree
		expect(out.profiles[0]).toHaveProperty('privateKeyArmor', '0xabc')
		expect(out.profiles[0]).toHaveProperty('mnemonicPhrase', 'w w w')
	})

	it('tolerates a null or empty tree', () => {
		expect(stripShellSecrets(null)).toBeNull()
		expect(stripShellSecrets({})).toEqual({})
	})
})

describe('accountAddressOf', () => {
	it('returns the checksum address of a public keyID', () => {
		expect(accountAddressOf({ keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94' })).toBe(
			'0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
		)
	})

	it('returns undefined when the keyID is not an address', () => {
		expect(accountAddressOf({ keyID: 'nope' })).toBeUndefined()
	})
})

describe('keepStoredPgpSecrets (write-back of the stored PGP key, boundary)', () => {
	it('copies the stored PGP secret into the write copy when the write copy lacks it', () => {
		const stored = { profiles: [{ keyID: '0x' + '1'.repeat(40), chatManager: { pgpKey: { publicKey: 'PUB', privateKey: 'P1' } } }] }
		const out: any = { profiles: [{ keyID: '0x' + '1'.repeat(40), chatManager: { pgpKey: { publicKey: 'PUB' } } }] }
		keepStoredPgpSecrets(stored, out)
		expect(out.profiles[0].chatManager.pgpKey.privateKey).toBe('P1')
	})

	it('does not overwrite a secret the write copy already has, and adds no EOA field', () => {
		const stored = { profiles: [{ keyID: 'k', privateKeyArmor: '0xEOA', chatManager: { pgpKey: { privateKey: 'P1' } } }] }
		const out: any = { profiles: [{ keyID: 'k', chatManager: { pgpKey: { privateKey: 'P2' } } }] }
		keepStoredPgpSecrets(stored, out)
		expect(out.profiles[0].chatManager.pgpKey.privateKey).toBe('P2')
		expect(out.profiles[0].privateKeyArmor).toBeUndefined()
	})
})

describe('pgpSecretsKeptForDisk (write layer, no shared references)', () => {
	it('returns a copy: the write input and the page state are not changed', () => {
		const stored = { profiles: [{ keyID: 'k', chatManager: { pgpKey: { privateKey: 'P1' } } }] }
		const out: any = { profiles: [{ keyID: 'k', chatManager: { pgpKey: { publicKey: 'PUB' } } }] }
		const kept: any = pgpSecretsKeptForDisk(stored, out)
		expect(kept.profiles[0].chatManager.pgpKey.privateKey).toBe('P1')
		expect(out.profiles[0].chatManager.pgpKey.privateKey).toBeUndefined()
		expect(kept.profiles[0].chatManager).not.toBe(out.profiles[0].chatManager)
	})
})
