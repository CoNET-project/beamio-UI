/**
 * @jest-environment node
 *
 * Y.95 at the gate (source check): the import result is consumed while the import page is open, the result never enters the app by
 * itself (it asks for a walletStatus read), and the eoa is only remembered as the public address. Reads the source only.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('AppEntryGate consumes nativeImportResult (Y.95)', () => {
	it('subscribes while the import page is open, and handles ok, already_exists, cancelled and failures', () => {
		expect(src).toMatch(/onNativeImportResult\(\(\{ code, eoa \}\)/)
		expect(src).toMatch(/if \(!awaitingImportReturn\) return/)
		expect(src).toMatch(/code === 'ok' \|\| code === 'already_exists'/)
		expect(src).toMatch(/code === 'cancelled'/)
	})

	it('a result asks for a walletStatus read; it does not enter the app or sign anything by itself', () => {
		const start = src.indexOf('onNativeImportResult(({ code, eoa })')
		const block = src.slice(start, src.indexOf('}, [awaitingImportReturn])', start))
		expect(block).toContain("notifyNativeWalletReady('')")
		expect(block).toContain('rememberNativeEoa(eoa)')
		expect(block).not.toMatch(/applyNativeWallet|applyLocalWallet|enterApp\(|goOnboarding|storeSystemData|privateKey/)
	})
})
