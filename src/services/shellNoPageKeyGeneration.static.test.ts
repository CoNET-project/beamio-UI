/**
 * @jest-environment node
 *
 * The shell never generates or derives an account or PGP private key in the page. Each entry point must
 * refuse before any generation or derivation. Reads the sources, so a removed guard fails.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

/** The head of the named function (up to the first derivation) must contain the shell refusal. */
function headOf(src: string, decl: RegExp, size = 1200): string {
	const m = decl.exec(src)
	expect(m).not.toBeNull()
	return src.slice(m!.index, m!.index + size)
}

describe('no page key generation or derivation in a shell', () => {
	const beamio = read('services/beamio.ts')
	const chat = read('services/chat.ts')
	const agent = read('utils/agentBusinessWorkspace.ts')

	it('createKeyHDWallets refuses (no random key, no derivation)', () => {
		expect(headOf(beamio, /const createKeyHDWallets = \(/)).toContain('isShellContext()')
	})
	it('createOrGetWallet refuses', () => {
		expect(headOf(beamio, /export const createOrGetWallet = async/)).toContain('isShellContext()')
	})
	it('createDetachedRecoverAccount refuses before its random key', () => {
		const h = headOf(beamio, /export const createDetachedRecoverAccount = async/)
		expect(h.indexOf('isShellContext()')).toBeLessThan(h.indexOf('ethers.Wallet.createRandom()') < 0 ? 1e9 : h.indexOf('ethers.Wallet.createRandom()'))
	})
	it('restoreWithUserPin refuses before any derivation', () => {
		expect(headOf(beamio, /export const restoreWithUserPin = async/)).toContain('isShellContext()')
	})
	it('unlockDetachedRecoverPrivateKey refuses before any derivation', () => {
		expect(headOf(beamio, /export const unlockDetachedRecoverPrivateKey = async/)).toContain('isShellContext()')
	})
	it('ensureProfilePrivateKeyArmorFromMnemonic refuses before the derivation', () => {
		expect(headOf(beamio, /export const ensureProfilePrivateKeyArmorFromMnemonic = \(/)).toContain('isShellContext()')
	})
	it('createAgentTempAccount refuses before any tag or key', () => {
		expect(headOf(agent, /export async function createAgentTempAccount\(/)).toContain('isShellContext()')
	})
	it('initBeamioPGPKeys and generatePgpKey refuse before generating a PGP key', () => {
		expect(headOf(chat, /const initBeamioPGPKeys = async/)).toContain('isShellContext()')
		expect(headOf(chat, /const generatePgpKey = async/)).toContain('isShellContext()')
	})
})
