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
		// 0.53.39: the walletStatus route (`if (native.status !== 'no_key') { iosSilentOnboarding(...) }`) was removed on purpose by cebd7e0;
		// the start is decided by the native pre-read, so that regex pin is deleted.
		expect(src).toMatch(/const startupWait = \(reason: string, code\?: StartReasonCode\) => \{/)
	})

	it('keeps the no_key watcher (identityPublic refusals are excluded inside the watcher)', () => {
		expect(src).toMatch(/installNativeNoKeyWatcher\(/)
	})

	it('reads no PGP or private key at the gate; identityPublic only as the kPresent boolean of a no_key answer', () => {
		expect(src).not.toMatch(/privateKeyArmor|pgpPrivateKeyArmored/)
		// superseded (spec item 42(2)): the start-up no-record entry no longer reads kPresent; the pre-read answer decides
		expect(src).not.toMatch(/readNativeIdentityPublic\(\)\.then\(\(r\) => \(r\.kind === 'no_key' \? r\.kPresent : undefined\)\)/)
		expect(src).toContain('const pre = await queryNativeMnemonicPreread()')
	})
})
