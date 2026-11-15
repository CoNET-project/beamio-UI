/**
 * (2 a, shell only): in a shell the restore page never calls scanRecoveryQr and never writes a scan
 * result into the recovery code. The recovery path sends nativeRecoveryOpen (the native recovery page scans and types). The browser
 * PWA is unchanged: its own camera and file scan stay. Source guard; no code or key value is used.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'RestoreWalletUnifiedScreen.tsx'), 'utf8')

describe('the restore page in a shell does not scan and does not write a scan result into the recovery code', () => {
	it('the scan:url listener returns before it writes the recovery code in a shell', () => {
		const at = src.indexOf("onWalletEvent('scan:url'")
		expect(at).toBeGreaterThan(0)
		const guard = src.indexOf('if (shell) return', at)
		const write = src.indexOf('setRecoveryCode(url)', at)
		expect(guard).toBeGreaterThan(at)
		expect(write).toBeGreaterThan(guard)
	})

	it('the scanned-code setter returns in a shell before it writes the recovery code (defensive guard, not only the render condition)', () => {
		const at = src.indexOf('const onScannedCode = (code: string) => {')
		expect(at).toBeGreaterThan(0)
		const guard = src.indexOf('if (shell) return', at)
		const write = src.indexOf('setRecoveryCode(code)', at)
		expect(guard).toBeGreaterThan(at)
		expect(write).toBeGreaterThan(guard)
	})

	it('the native scan is never offered in a shell (iosNativeScan is false when shell)', () => {
		expect(src).toContain('!shell && getCashTreesNativeNfcHost() === \'ios\'')
	})

	it('a shell forces the recovery tab and shows only the native recovery entry, which sends nativeRecoveryOpen', () => {
		expect(src).toContain("const activeTab: RestoreTab = shell ? 'recovery' : tab")
		expect(src).toContain("activeTab === 'recovery' && shell ? (")
		const shellBranch = src.indexOf("activeTab === 'recovery' && shell ? (")
		expect(src.slice(shellBranch, shellBranch + 400)).toContain('openNativeRecovery')
		const openAt = src.indexOf('const openNativeRecovery = async () => {')
		expect(openAt).toBeGreaterThan(0)
		expect(src.slice(openAt, openAt + 400)).toContain('await nativeRecoveryOpen()')
	})

	it('the recovery submit in a shell goes to the native recovery page, never to a restore from a page-typed code', () => {
		const submitAt = src.indexOf('const handleRecoverySubmit = async (e: FormEvent) => {')
		expect(submitAt).toBeGreaterThan(0)
		const shellGuard = src.indexOf('if (shell) {', submitAt)
		const pageRestore = src.indexOf('restoreWithRedeem(recoveryCode', submitAt)
		expect(shellGuard).toBeGreaterThan(submitAt)
		expect(pageRestore).toBeGreaterThan(shellGuard)
		expect(src.slice(shellGuard, shellGuard + 80)).toContain('await openNativeRecovery()')
	})

	it('the browser PWA keeps its own scan entry (unchanged by this commit)', () => {
		expect(src).toContain("setTab('scan')")
		expect(src).toContain('<RecoveryQrScanPanel')
	})
})
