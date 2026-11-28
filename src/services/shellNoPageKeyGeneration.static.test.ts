/**
 * @jest-environment node
 *
 * home-bridge-deferred-sdk: PWA owns Create / Restore key material even in shell.
 * Early Chat / PGP SDK generation stays refused until after /home handoff (native SDK).
 * Agent detached keys still refuse in shell.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

function headOf(src: string, decl: RegExp, size = 1200): string {
	const m = decl.exec(src)
	expect(m).not.toBeNull()
	return src.slice(m!.index, m!.index + size)
}

describe('home-bridge-deferred-sdk key ownership', () => {
	const beamio = read('services/beamio.ts')
	const chat = read('services/chat.ts')
	const agent = read('utils/agentBusinessWorkspace.ts')
	const createScreen = read('pages/Home/CreateUsernamePinScreen.tsx')
	const restoreScreen = read('pages/Home/RestoreWalletUnifiedScreen.tsx')
	const handoff = read('services/homeBridgeHandoff.ts')

	it('createKeyHDWallets no longer refuses shell (PWA owns Create)', () => {
		const h = headOf(beamio, /const createKeyHDWallets = \(/)
		expect(h).toContain('home-bridge-deferred-sdk')
		expect(h).not.toMatch(/if \(isShellContext\(\)\) return null/)
	})
	it('createOrGetWallet no longer refuses shell', () => {
		const h = headOf(beamio, /export const createOrGetWallet = async/)
		expect(h).toContain('home-bridge-deferred-sdk')
		expect(h).not.toMatch(/if \(isShellContext\(\)\) return null/)
	})
	it('restoreWithUserPin no longer throws native_recovery_only', () => {
		const h = headOf(beamio, /export const restoreWithUserPin = async/)
		expect(h).toContain('home-bridge-deferred-sdk')
		expect(h).not.toContain("native_recovery_only")
	})
	it('restoreWithRedeemDetailed no longer throws native_recovery_only', () => {
		const h = headOf(beamio, /export const restoreWithRedeemDetailed = async/)
		expect(h).toContain('home-bridge-deferred-sdk')
		expect(h).not.toContain("native_recovery_only")
	})
	it('createDetachedRecoverAccount still refuses before its random key', () => {
		const h = headOf(beamio, /export const createDetachedRecoverAccount = async/)
		expect(h.indexOf('isShellContext()')).toBeLessThan(h.indexOf('ethers.Wallet.createRandom()') < 0 ? 1e9 : h.indexOf('ethers.Wallet.createRandom()'))
	})
	it('unlockDetachedRecoverPrivateKey still refuses before any derivation', () => {
		expect(headOf(beamio, /export const unlockDetachedRecoverPrivateKey = async/)).toContain('isShellContext()')
	})
	it('createAgentTempAccount refuses before any tag or key', () => {
		expect(headOf(agent, /export async function createAgentTempAccount\(/)).toContain('isShellContext()')
	})
	it('initBeamioPGPKeys and generatePgpKey refuse before generating a PGP key (early SDK = 0)', () => {
		expect(headOf(chat, /const initBeamioPGPKeys = async/)).toContain('isShellContext()')
		expect(headOf(chat, /const generatePgpKey = async/)).toContain('isShellContext()')
	})
	it('Create screen uses createRecover (not handleShellCreate call site)', () => {
		expect(createScreen).toContain('home-bridge-deferred-sdk: PWA owns Create')
		expect(createScreen).toMatch(/kks = await createRecover\(/)
		expect(createScreen).not.toMatch(/await handleShellCreate\(/)
	})
	it('Restore screen does not call nativeRecoverySubmit', () => {
		expect(restoreScreen).toContain('nativeRecoverySubmit = 0')
		expect(restoreScreen).not.toMatch(/nativeRecoverySubmit\(/)
		expect(restoreScreen).not.toMatch(/nativeRecoveryOpen\(/)
	})
	it('homeBridgeHandoff module seals or plaintext-syncs once', () => {
		expect(handoff).toContain('runColdStartHomeHandoffOnce')
		expect(handoff).toContain('setPendingHomeMnemonicHandoff')
		expect(handoff).toContain('sendPwaWalletSync')
	})
})
