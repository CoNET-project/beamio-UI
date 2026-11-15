/**
 * @jest-environment node
 *
 * Static check of the shell entry decision: the gate decides from walletStatus, and an identityPublic
 * refusal is not an entry answer. Reads the source only; no key material.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('AppEntryGate decides shell entry from walletStatus', () => {
	it('a no_key native wallet is not turned into the import route; the page wallet decides (boundary)', () => {
		expect(src).not.toMatch(/readNativeWalletStatus/)
		expect(src).toMatch(/if \(native\.status !== 'no_key'\) \{[\s\S]{0,200}showStorageUnavailable/)
	})

	it('keeps the no_key watcher (identityPublic refusals are excluded inside the watcher)', () => {
		expect(src).toMatch(/installNativeNoKeyWatcher\(/)
	})

	it('does not read the identity, a PGP key or a private key at the gate', () => {
		expect(src).not.toMatch(/identityPublic|readNativeIdentityPublic|privateKeyArmor|pgpPrivateKeyArmored/)
	})
})
