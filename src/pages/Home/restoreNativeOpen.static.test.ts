/**
 * @jest-environment node
 *
 * eng-home-bridge-deferred-sdk: Restore is PWA-owned in shell and browser.
 * nativeRecoverySubmit / nativeRecoveryOpen session = 0 on the restore page path.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')

describe('restore screen: PWA-owned restore (home-bridge-deferred-sdk)', () => {
	const screen = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')
	const beamio = read('src/services/beamio.ts')

	it('documents PWA restore in shell (nativeRecoverySubmit = 0)', () => {
		expect(screen).toMatch(/home-bridge-deferred-sdk/)
		expect(screen).toMatch(/nativeRecoverySubmit = 0/)
		expect(screen).toMatch(/restoreWithUserPin|restoreWithRedeemDetailed/)
	})

	it('login path calls restoreWithUserPin (no shellSubmit / nativeRecoverySubmit)', () => {
		const at = screen.indexOf('const handleLoginSubmit = async')
		expect(at).toBeGreaterThan(0)
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at) + 4)
		expect(body).toMatch(/restoreWithUserPin\(/)
		expect(body).not.toMatch(/shellSubmit\(/)
		expect(body).not.toMatch(/await\s+shellSubmit|NativeRecoverySubmitInput|path:\s*'account'/)
	})

	it('recovery-code path calls restoreWithRedeemDetailed (no shellSubmit)', () => {
		const at = screen.indexOf('const handleRecoverySubmit = async')
		expect(at).toBeGreaterThan(0)
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at) + 4)
		expect(body).toMatch(/restoreWithRedeemDetailed\(/)
		expect(body).not.toMatch(/shellSubmit\(/)
		expect(body).not.toMatch(/path:\s*'code'/)
	})

	it('does not open a nativeRecovery session on mount or cancel on leave', () => {
		expect(screen).not.toMatch(/nativeRecoveryOpen\(/)
		expect(screen).not.toMatch(/nativeRecoveryCancel\(/)
		expect(screen).not.toMatch(/sessionOpenRef/)
	})

	it('does not listen for nativeRecoveryResult to enter home', () => {
		expect(screen).not.toMatch(/onNativeRecoveryResult\(/)
	})

	it('restore page carries no console or publishNativePwaLog of credentials', () => {
		expect(screen).not.toMatch(/console\.(log|info|warn|error|debug)/)
		expect(screen).not.toMatch(/publishNativePwaLog/)
	})

	it.each(['restoreWithRedeemDetailed', 'restoreWithUserPin'])(
		'%s no longer throws native_recovery_only',
		name => {
			const at = beamio.indexOf(`export const ${name} = async`)
			expect(at).toBeGreaterThan(0)
			const head = beamio.slice(at, at + 800)
			expect(head).not.toContain('native_recovery_only')
			expect(head).toContain('home-bridge-deferred-sdk')
		},
	)
})
