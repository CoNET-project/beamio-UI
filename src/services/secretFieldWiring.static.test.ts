/**
 * @jest-environment node
 *
 * Paste hardening (2026-11-13) and the shell recovery path, read from the sources: every password-type input carries the
 * secret guard, and the shell never reaches the in-page recovery code call.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

const PASSWORD_INPUT_FILES = [
	'src/components/passcode/PasscodeDotInput.tsx',
	'src/pages/Home/CreateUsernamePinScreen.tsx',
	'src/components/Setting/RecoveryBackupScreen.tsx',
	'src/components/Setting/PrivateKey/PrivateKey.tsx',
	'src/components/Setting/PrivateKey/recoverQR.tsx',
	'src/pages/Home/RestoreWalletUnifiedScreen.tsx',
]

describe('password-type inputs carry the secret guard', () => {
	it.each(PASSWORD_INPUT_FILES)('%s: every password input spreads secretFieldProps', (rel) => {
		const text = read(rel)
		const passwordInputs = (text.match(/type=(\{[^}]*password[^}]*\}|"password")/g) ?? []).length
		const guards = (text.match(/\{\.\.\.secretFieldProps\('(pin|secret)'\)\}/g) ?? []).length
		expect(passwordInputs).toBeGreaterThan(0)
		expect(guards).toBeGreaterThanOrEqual(passwordInputs)
	})

	it('the recovery code field is a password field with a peek toggle and the secret guard (browser)', () => {
		const text = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')
		const k = text.indexOf('id="welcome-back-recovery-code"')
		expect(k).toBeGreaterThan(0)
		const window = text.slice(k - 600, k + 400)
		expect(window).toMatch(/\{\.\.\.secretFieldProps\('secret'\)\}/)
		expect(window).toMatch(/type=\{peekRecovery \? 'text' : 'password'\}/)
	})

	it('the login password field no longer offers autofill', () => {
		const text = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')
		const k = text.indexOf('id="welcome-back-password"')
		expect(text.slice(k - 300, k + 500)).not.toMatch(/autoComplete="current-password"/)
	})
})

describe('shell recovery path', () => {
	const restore = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')

	it('0.53.49: a shell shows the same tabs as the browser, with the secret guard on every field', () => {
		expect(restore).toContain('const activeTab: RestoreTab = tab')
		expect(restore).not.toMatch(/activeTab === 'recovery' && shell \? \(/)
		const k = restore.indexOf('id="welcome-back-recovery-code"')
		expect(restore.slice(k - 600, k + 1200)).toMatch(/\{\.\.\.secretFieldProps\('secret'\)\}/)
		expect(restore.slice(k - 600, k + 1200)).toMatch(/autoComplete="off"[\s\S]*autoCorrect="off"|autoCorrect="off"[\s\S]*autoComplete="off"/)
	})

	it('the recovery submit in a shell goes to the engine before any in-page restore call', () => {
		const fn = restore.indexOf('const handleRecoverySubmit = async')
		const guard = restore.indexOf('if (shell) {', fn)
		const call = restore.indexOf('restoreWithRedeemDetailed(recoveryCode', fn)
		expect(fn).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(fn)
		expect(call).toBeGreaterThan(guard)
	})

	it('the shell outcome is a short code: ok enters without a reload, the others show PWA copy', () => {
		expect(restore).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa, cooldownSec \}\) => \{/)
		expect(restore).toMatch(/if \(code === 'ok'\) \{[\s\S]{0,700}notifyNativeWalletReady\(initialBeamioTag, eoa\)/)
		expect(restore).not.toMatch(/if \(code === 'ok'\) \{\s*window\.location\.reload\(\)/)
		expect(restore).toMatch(/nativeRecoveryCopyKey\(code\)/)
	})

	it('the open command carries only its type and reqId; the credential goes only in the submit action', () => {
		const native = read('src/services/nativeRecovery.ts')
		expect(native).toMatch(/requestNativeAck\(\{ type: NATIVE_RECOVERY_OPEN_COMMAND \}/)
		expect(native).toMatch(/type: NATIVE_RECOVERY_SUBMIT_COMMAND, reqId: nextReqId\(\), path: 'code', code: input\.code/)
	})
})
