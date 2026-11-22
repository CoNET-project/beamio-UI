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

	it('the shell shows the native recovery button in place of the recovery code form', () => {
		//a shell renders from activeTab, which is always 'recovery' in a shell (no password tab).
		expect(restore).toContain("const activeTab: RestoreTab = shell ? 'recovery' : tab")
		expect(restore).toMatch(/activeTab === 'recovery' && shell \? \(/)
		expect(restore).toMatch(/onClick=\{\(\) => void openNativeRecovery\(\)\}/)
	})

	it('the recovery submit returns to the native page in a shell, before any in-page call', () => {
		const fn = restore.indexOf('const handleRecoverySubmit = async')
		const guard = restore.indexOf('if (shell) {', fn)
		const call = restore.indexOf('restoreWithRedeemDetailed(recoveryCode', fn)
		expect(fn).toBeGreaterThan(0)
		expect(guard).toBeGreaterThan(fn)
		expect(call).toBeGreaterThan(guard)
	})

	it('the shell outcome is a short code: ok enters without a reload, legacy_record shows its line', () => {
		expect(restore).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa \}\) => \{/)
		expect(restore).toMatch(/if \(code === 'ok'\) \{[\s\S]{0,500}notifyNativeWalletReady\(initialBeamioTag, eoa\)/)
		expect(restore).not.toMatch(/if \(code === 'ok'\) \{\s*window\.location\.reload\(\)/)
		expect(restore).toMatch(/nativeRecoveryCopyKey\(code\)[\s\S]{0,40}setRecoveryError\(tu\(copyKey\)\)/)  // legacy_record keeps its copy through the mapping
	})

	it('the native recovery command carries only its type and reqId', () => {
		const native = read('src/services/nativeRecovery.ts')
		expect(native).toMatch(/requestNativeAck\(\{ type: NATIVE_RECOVERY_OPEN_COMMAND \}/)
	})
})
