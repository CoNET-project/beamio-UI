/**
 * @jest-environment node
 */
/**
 * r92 steps 1 and 2: the old PWA store (PouchDB "conet" / "init", plaintext mnemonicPhrase) read first in a shell.
 * The vector is the standard BIP-39 test phrase (public, no funds): m/44'/60'/0'/0/0 = 0x9858EfFD232B4033E47d90003D41EC34EcaEda94.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { decideLegacyInit, mnemonicEoa, stripLegacyChatContainers } from './shellLegacyIdbInit'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER = '0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb'

describe('decideLegacyInit (24.1 (c), 24.5 (a) and (b))', () => {
	it('the derived address of the phrase is the standard index 0 account', () => {
		expect(mnemonicEoa(PHRASE)).toBe(ADDR)
	})

	it('a valid mnemonic whose address equals profiles[0].keyID is valid (the account is entered)', () => {
		expect(decideLegacyInit({ mnemonicPhrase: PHRASE, profiles: [{ keyID: ADDR }] })).toEqual({ status: 'valid', eoa: ADDR })
	})

	it('a mixed-case keyID is compared in lower case', () => {
		expect(decideLegacyInit({ mnemonicPhrase: PHRASE, profiles: [{ keyID: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' }] }).status).toBe('valid')
	})

	it('rule C (PWA-local): a mnemonic that derives to another account is no valid mnemonic (absent): not used, not changed, the native side decides', () => {
		expect(decideLegacyInit({ mnemonicPhrase: PHRASE, profiles: [{ keyID: OTHER }] })).toEqual({ status: 'absent' })
	})

	it('rule C (PWA-local): a mnemonic with no profile has no keyID to match, so it is no valid mnemonic (absent)', () => {
		expect(decideLegacyInit({ mnemonicPhrase: PHRASE, profiles: [] })).toEqual({ status: 'absent' })
	})

	it('an invalid phrase (bad checksum) is unknown, not confirmed empty', () => {
		expect(decideLegacyInit({ mnemonicPhrase: 'abandon abandon abandon', profiles: [{ keyID: ADDR }] })).toEqual({ status: 'unknown', reason: 'native_retry' })
	})

	it('a missing document, or a document with no mnemonic, is confirmed empty (absent)', () => {
		expect(decideLegacyInit(null)).toEqual({ status: 'absent' })
		expect(decideLegacyInit({ profiles: [{ keyID: ADDR }] })).toEqual({ status: 'absent' })
		expect(decideLegacyInit({ mnemonicPhrase: '   ', profiles: [{ keyID: ADDR }] })).toEqual({ status: 'absent' })
	})

	it('the module derives only from the phrase; it holds no private key field', () => {
		const src = readFileSync(join(__dirname, 'shellLegacyIdbInit.ts'), 'utf8')
		expect(src).not.toMatch(/privateKey|privateKeyArmor|createKeyHDWallets/)
	})
})

describe('beamio.ts wiring (static): the native read comes first; the old store is read only after it and never written by the shell read', () => {
	const src = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
	const readFn = src.slice(src.indexOf('const readLegacyShellInit = async'), src.indexOf('const readStorageWithStatus = async'))
	const startFn = src.slice(src.indexOf('const readStorageWithStatus = async'), src.indexOf('const readStorageWithStatus = async') + 4000)

	it('the shell branch reads the native record first (shellNativeFirstRead), then the old store', () => {
		const nativeAt = startFn.indexOf('await shellNativeFirstRead(')
		const legacyAt = startFn.indexOf('await readLegacyShellInit()')
		expect(nativeAt).toBeGreaterThan(0)
		expect(legacyAt).toBeGreaterThan(nativeAt)
	})

	it('the legacy read writes nothing (no PouchDB write, no native write)', () => {
		expect(readFn).not.toMatch(/storageHashData|putDocDurable|removeDocIfExists|shellRecordWrite|database\.put|database\.remove/)
	})

	it('a failure or timeout of the legacy read is unknown (native_retry), never a confirmed empty', () => {
		expect(readFn).toContain('LEGACY_SHELL_READ_TIMEOUT_MS')
		const catchBlock = readFn.slice(readFn.indexOf('} catch {'), readFn.indexOf('const data = raw'))
		expect(catchBlock).toContain("'native_retry'")
		expect(catchBlock).not.toContain("'absent'")
	})
})

describe('stripLegacyChatContainers: every PGP public path the shell write refuses (presence, empty strings too), on a copy only', () => {
	const old = () => ({
		mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
		isReady: true,
		beamio: { pgpPublicKeyID: '', pgpPublicKeyArmor: '', userName: 'kept' },
		profiles: [
			{
				keyID: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
				userName: 'kept',
				pgpKey: { keyID: 'synthetic', publicKey: 'SYNTHETIC-PUB', privateKey: 'SYNTHETIC-PRIV' },
				chatManager: { router: '', pgpKey: { keyID: 'synthetic-cm', publicKey: 'SYNTHETIC-CM-PUB' } },
				chats: [{ peer: 'kept', chatData: { publicArmored: '', msgs: [] } }, { peer: 'kept2', chatData: { publicArmored: 'SYNTHETIC-PEER', msgs: [] } }],
			},
		],
	})
	it('removes all five paths from the copy, keeps the other fields, and does not change the input', () => {
		const input = old()
		const before = JSON.stringify(input)
		const out = stripLegacyChatContainers(input) as any
		expect(JSON.stringify(input)).toBe(before)
		const text = JSON.stringify(out)
		expect(text).not.toMatch(/pgpKey|publicArmored|pgpPublicKeyID|pgpPublicKeyArmor|SYNTHETIC/)
		expect(out.beamio.userName).toBe('kept')
		expect(out.profiles[0].userName).toBe('kept')
		expect(out.profiles[0].chats[0].peer).toBe('kept')
		expect(out.profiles[0].chats[0].chatData.msgs).toEqual([])
		expect(out.profiles[0].chatManager.router).toBe('')
		expect(out.mnemonicPhrase).toBe(input.mnemonicPhrase)
	})
	it('a record without any of these paths is returned unchanged in content', () => {
		const plain = { mnemonicPhrase: 'x', profiles: [{ keyID: '0xabc', userName: 'a' }] }
		expect(stripLegacyChatContainers(plain)).toEqual(plain)
	})
})

