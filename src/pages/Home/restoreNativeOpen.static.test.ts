/**
 * @jest-environment node
 *
 * 0.53.49 (plan A, P1), read from the sources: the shell shows the PWA restore page. The credential goes to the native engine through
 * nativeRecoverySubmit; the page never decrypts in a shell; nothing is logged; the page state is cleared as soon as the request is built.
 * The outcome is still the nativeRecoveryResult event.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')

describe('restore screen: shell recovery through the PWA page', () => {
	const screen = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')
	const native = read('src/services/nativeRecovery.ts')

	it('opens the session with nativeRecoveryOpen and never the import command', () => {
		expect(native).toMatch(/NATIVE_RECOVERY_OPEN_COMMAND = 'nativeRecoveryOpen'/)
		expect(native).not.toMatch(/nativeImportOpen/)
		expect(screen).not.toMatch(/nativeImportOpen|openNativeKeyImport/)
	})

	it('a failed open or submit shows the key for its reason', () => {
		const at = screen.indexOf('const shellSubmit = async')
		expect(at).toBeGreaterThan(0)
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at))
		expect(body).toMatch(/showError\(tu\(recoveryOpenErrorKey\(out\.reason\)\)\)/)
		expect(body).toMatch(/showError\(tu\(recoveryOpenErrorKey\(sent\.reason\)\)\)/)
	})

	it('the outcome is a result event: ok enters without a reload, every other code shows PWA copy and keeps the session', () => {
		expect(screen).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa, cooldownSec \}\) => \{[\s\S]*?if \(code === 'ok'\)[\s\S]*?notifyNativeWalletReady\(initialBeamioTag, eoa\)/)
		expect(screen).not.toMatch(/if \(code === 'ok'\) \{\s*window\.location\.reload\(\)/)
		expect(screen).toMatch(/const copyKey = nativeRecoveryCopyKey\(code\)/)
		expect(screen).toMatch(/copyKey \?\? 'something_went_wrong_while_restoring_your_wallet'/)
	})

	it('the shell has no origin-free path: the gate needs the top frame, a trusted origin and the shell capability', () => {
		expect(screen).toMatch(/isTopFrameForRecovery\(\)/)
		expect(screen).toMatch(/isTrustedRecoveryOrigin\(\)/)
		expect(screen).toMatch(/hasPageInputRecovery\(\)/)
		expect(screen).toMatch(/if \(gate\.state !== 'ready'\)/)
	})

	it('the shell login path validates, builds the request, clears the password, and only then sends it', () => {
		const at = screen.indexOf('const handleLoginSubmit = async')
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at))
		const validate = body.indexOf("tu('password_must_be_at_least_6_characters')")
		const shellAt = body.indexOf('if (shell) {')
		const build = body.indexOf("const payload: NativeRecoverySubmitInput = { path: 'account'")
		const clear = body.indexOf("setPin('')")
		const send = body.indexOf('await shellSubmit(payload)')
		const pageRestore = body.indexOf('restoreWithUserPin(')
		expect(validate).toBeGreaterThan(0)
		expect(shellAt).toBeGreaterThan(validate)
		expect(build).toBeGreaterThan(shellAt)
		expect(clear).toBeGreaterThan(build)
		expect(send).toBeGreaterThan(clear)
		expect(pageRestore).toBeGreaterThan(send)
	})

	it('the shell recovery code path validates the format, builds the request, clears the field, and only then sends it', () => {
		const at = screen.indexOf('const handleRecoverySubmit = async')
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at))
		const shellAt = body.indexOf('if (shell) {')
		const format = body.indexOf('isRecoveryCodeFormat(code)')
		const build = body.indexOf("const payload: NativeRecoverySubmitInput = { path: 'code'")
		const clear = body.indexOf("setRecoveryCode('')")
		const send = body.indexOf('await shellSubmit(payload)')
		const pageRestore = body.indexOf('restoreWithRedeemDetailed(recoveryCode')
		expect(shellAt).toBeGreaterThan(0)
		expect(format).toBeGreaterThan(shellAt)
		expect(build).toBeGreaterThan(format)
		expect(clear).toBeGreaterThan(build)
		expect(send).toBeGreaterThan(clear)
		expect(pageRestore).toBeGreaterThan(send)
	})

	it('leaving with a session open sends nativeRecoveryCancel', () => {
		expect(screen).toMatch(/if \(sessionOpenRef\.current\) \{\s*sessionOpenRef\.current = false\s*void nativeRecoveryCancel\(\)/)
	})

	it('the page restore files carry no console or native log call (an input must not reach logcat or the unified log)', () => {
		expect(screen).not.toMatch(/console\.(log|info|warn|error|debug)/)
		expect(screen).not.toMatch(/publishNativePwaLog/)
		const at = native.indexOf('0.53.49 (plan A, P1)')
		expect(at).toBeGreaterThan(0)
		const section = native.slice(at, native.indexOf('Native account creation. `nativeAccountCreateOpen`', at))
		expect(section).not.toMatch(/console\.|publishNativePwaLog/)
	})

	it('there is no pwaEmptySignal sender in the non-test source tree (cold start must not add one)', () => {
		const { spawnSync } = require('child_process') as typeof import('child_process')
		const r = spawnSync('git', ['grep', '-n', '-E', "(type|command)\\s*[:=]\\s*['\"]pwaEmptySignal|sendPwaEmptySignal|PWA_EMPTY_SIGNAL", '--', 'src', ':!*.test.ts', ':!*.test.tsx'], { cwd: join(__dirname, '..', '..', '..'), encoding: 'utf8' })
		expect(r.status).toBe(1) // 1 = no match
		expect(r.stdout).toBe('')
	})
})

describe('the in-page restore functions still refuse a shell (the page does not decrypt there)', () => {
	const beamio = read('src/services/beamio.ts')

	it.each(['restoreWithRedeem', 'restoreWithUserPin'])('%s throws before any read', (name) => {
		const at = beamio.indexOf(`export const ${name} = async`)
		expect(at).toBeGreaterThan(0)
		const guard = beamio.indexOf("if (isShellContext()) throw new Error('native_recovery_only')", at)
		const firstRead = beamio.indexOf('fetch(', at)
		expect(guard).toBeGreaterThan(at)
		expect(firstRead === -1 || guard < firstRead).toBe(true)
	})
})
