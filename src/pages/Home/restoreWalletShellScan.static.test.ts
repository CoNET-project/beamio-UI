/**
 * 0.53.49 (plan A, P1): the restore page scans in a shell too, with the page's own camera and file pick (jsQR). The native scanRecoveryQr
 * bridge is never called from this page, and only the recovery code format fills the field. Source guard; no code or key value is used.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'RestoreWalletUnifiedScreen.tsx'), 'utf8')

describe('the restore page scans in a shell with the page camera and file pick', () => {
	it('the scan:url listener and the scanned-code setter no longer return early in a shell', () => {
		const at = src.indexOf("onWalletEvent('scan:url'")
		expect(src.slice(at, at + 300)).not.toContain('if (shell) return')
		const at2 = src.indexOf('const onScannedCode = (code: string) => {')
		expect(src.slice(at2, at2 + 300)).not.toContain('if (shell) return')
	})

	it('only the recovery code format fills the field (a mnemonic, a key or a URL is refused)', () => {
		const at = src.indexOf('const onScannedCode = (code: string) => {')
		const body = src.slice(at, src.indexOf('\n\t}\n', at))
		expect(body).toContain("/^http/i.test(code) || !isRecoveryCodeFormat(code)")
		expect(body.indexOf('invalid_recovery_code_format')).toBeLessThan(body.indexOf('setRecoveryCode(code)'))
	})

	it('the native scan bridge is never offered in a shell (iosNativeScan is false when shell)', () => {
		expect(src).toContain("!shell && getCashTreesNativeNfcHost() === 'ios'")
		expect(src).toContain('nativeScan={iosNativeScan ? scanRecoveryQrWithIosBridge : undefined}')
	})

	it('a shell no longer forces the recovery tab or shows a native-entry button', () => {
		expect(src).toContain("const activeTab: RestoreTab = tab")
		expect(src).not.toContain("activeTab === 'recovery' && shell ? (")
		expect(src).not.toContain('openNativeRecovery')
	})

	it('the browser PWA keeps its own scan entry', () => {
		expect(src).toContain("setTab('scan')")
		expect(src).toContain('<RecoveryQrScanPanel')
	})
})
