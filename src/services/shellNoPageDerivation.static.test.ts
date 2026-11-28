/**
 * @jest-environment node
 *
 * home-bridge-deferred-sdk: ensureProfilePrivateKeyArmorFromMnemonic may derive in shell
 * (PWA owns account keys). Chat/PGP still refused separately until post-handoff SDK init.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', '..', 'src', 'services', 'beamio.ts'), 'utf8')
const fn = src.indexOf('export const ensureProfilePrivateKeyArmorFromMnemonic = (')
const body = src.slice(fn, src.indexOf('const getDuplicateOwnership', fn))

describe('ensureProfilePrivateKeyArmorFromMnemonic (home-bridge)', () => {
	it('derives from mnemonic without a shell early-return guard', () => {
		expect(fn).toBeGreaterThan(0)
		expect(body).toContain('createKeyHDWallets(phrase)')
		expect(body).not.toContain('if (isShellContext()) return data')
	})
})
