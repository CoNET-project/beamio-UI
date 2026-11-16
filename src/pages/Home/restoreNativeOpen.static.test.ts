/**
 * @jest-environment node
 *
 * Shell recovery entry, read from the sources: the command is nativeRecoveryOpen; a failed open
 * shows its own line; an ack ok is not a success; the outcome comes as nativeRecoveryResult; the shell never calls the in-page
 * restore functions; the entry stays visible (open).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')

describe('restore screen: shell recovery entry', () => {
	const screen = read('src/pages/Home/RestoreWalletUnifiedScreen.tsx')
	const native = read('src/services/nativeRecovery.ts')

	it('opens the recovery page with nativeRecoveryOpen, never the import command', () => {
		expect(native).toMatch(/NATIVE_RECOVERY_OPEN_COMMAND = 'nativeRecoveryOpen'/)
		expect(native).not.toMatch(/nativeImportOpen/)
		expect(screen).not.toMatch(/nativeImportOpen|openNativeKeyImport/)
	})

	it('a failed open shows the key for its reason, not the generic line only', () => {
		const at = screen.indexOf('const openNativeRecovery = async')
		expect(at).toBeGreaterThan(0)
		const body = screen.slice(at, screen.indexOf('const handleRecoverySubmit', at))
		expect(body).toMatch(/if \(!out\.ok\) setRecoveryError\(tu\(recoveryOpenErrorKey\(out\.reason\)\)\)/)
	})

	it('the outcome is a result event: ok enters without a reload, legacy_record shows its line, the others stay with the native page', () => {
		expect(screen).toMatch(/onNativeRecoveryResult\(\(\{ code, eoa \}\) => \{[\s\S]*?if \(code === 'ok'\)[\s\S]*?notifyNativeWalletReady\(initialBeamioTag, eoa\)/)
		expect(screen).not.toMatch(/if \(code === 'ok'\) \{\s*window\.location\.reload\(\)/)
		expect(screen).toMatch(/const copyKey = nativeRecoveryCopyKey\(code\)\s*if \(copyKey\) setRecoveryError\(tu\(copyKey\)\)/)  // legacy_record keeps its copy through the mapping
	})

	it('the recovery code is not typed in this page in a shell', () => {
		expect(screen).toMatch(/if \(shell\) \{\s*await openNativeRecovery\(\)\s*return\s*\}/)
	})

	it('the shell login path opens the native page instead of restoring in the page', () => {
		const at = screen.indexOf('const handleLoginSubmit = async')
		expect(at).toBeGreaterThan(0)
		const body = screen.slice(at, screen.indexOf('\n\t}\n', at))
		const shellAt = body.indexOf('if (shell) {')
		const callAt = body.indexOf('restoreWithUserPin(')
		expect(shellAt).toBeGreaterThan(0)
		expect(body).toMatch(/if \(shell\) \{[\s\S]*?nativeRecoveryOpen\(\)[\s\S]*?return\s*\}/)
		expect(callAt).toBeGreaterThan(shellAt)
	})
})

describe('the in-page restore functions refuse a shell', () => {
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
