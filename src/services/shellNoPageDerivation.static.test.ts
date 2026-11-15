/**
 * @jest-environment node
 *
 * in a shell the page derives no account key from a mnemonic (the native layer holds keys). Reads the source.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', '..', 'src', 'services', 'beamio.ts'), 'utf8')
const fn = src.indexOf('export const ensureProfilePrivateKeyArmorFromMnemonic = (')
const body = src.slice(fn, src.indexOf('const getDuplicateOwnership', fn))

describe('no page key derivation in a shell', () => {
	it('the shell guard comes before the mnemonic derivation', () => {
		const guard = body.indexOf('if (isShellContext()) return data')
		const derive = body.indexOf('createKeyHDWallets(phrase)')
		expect(fn).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(0)
		expect(derive).toBeGreaterThan(guard)
	})
})
