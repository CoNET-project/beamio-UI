/**
 * Static guard for the  禁止 2 rule: chat.ts must not use the account private key as AES key material. The PGP blob
 * is opened and sealed inside walletCore (ownPgpBlob.ts / pgpBlob.ts). This reads the source; it does not run chat.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const CHAT = readFileSync(join(__dirname, 'chat.ts'), 'utf8')

describe('chat.ts holds no AES key material from the account key', () => {
	it('does not import the AES helpers from beamio', () => {
		expect(CHAT).not.toMatch(/import\s*\{[^}]*\baesGcm(En|De)crypt\b[^}]*\}\s*from\s*['"]@\/services\/beamio['"]/)
	})

	it('calls no aesGcmEncrypt / aesGcmDecrypt at all', () => {
		expect(CHAT).not.toMatch(/\baesGcm(En|De)crypt\s*\(/)
	})

	it('a new PGP key is generated only after the read-failure guard (blocksNewPgpKey) and never on a read error', () => {
		// New account: after the read-failure guard in initBeamioPGPKeys.
		const guard = CHAT.indexOf('blocksNewPgpKey(own.read)')
		const create = CHAT.indexOf("generatePgpKey(profile.keyID,'')")
		expect(guard).toBeGreaterThan(0)
		expect(create).toBeGreaterThan(guard)
	})

	it('the user click generates only after a successful read and an unchanged chain (regeneratePgpKeyByUser)', () => {
		// After the user click (plan A, 2026-11-13): a read error or a changed chain stops before any generation.
		const fn = CHAT.indexOf('export const regeneratePgpKeyByUser')
		const readError = CHAT.indexOf("if (own.read.status === 'error') return { ok: false, reason: 'read_error' }", fn)
		const changed = CHAT.indexOf('if (snapshotOfRead(own.read) !== shown) return', fn)
		const create = CHAT.indexOf("generatePgpKey(profile.keyID, '')", fn)
		expect(fn).toBeGreaterThan(0)
		expect(readError).toBeGreaterThan(fn)
		expect(changed).toBeGreaterThan(readError)
		expect(create).toBeGreaterThan(changed)
	})

	it('reads and writes the blob only through the wallet module', () => {
		expect(CHAT).toMatch(/readOwnPgpPrivateArmored\(/)
		expect(CHAT).toMatch(/walletCore\.pgpBlobSeal\(|walletCore\.pgpBlobLegacySeal\(/)
	})
})
