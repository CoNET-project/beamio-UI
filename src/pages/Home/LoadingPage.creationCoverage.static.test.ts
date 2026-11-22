/**
 * 0.53.44 open point (c) coverage: every explicit account-creation completion opens the page write gate, and every restore write runs in
 * the restore write window (AppEntryGate opens the gate only after the read-back). Static pin of the wiring in LoadingPage.tsx; the runtime
 * callbacks are driven in App.onboardGapRepro.test.tsx. Removing a wiring must fail here.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'LoadingPage.tsx'), 'utf8')

describe('explicit account-creation callbacks open the page write gate (0.53.44 open point c)', () => {
	it('the CreateUsernamePinScreen completion calls onNewAccountCreated before the onboarding saves', () => {
		const mounts = src.split('<CreateUsernamePinScreen ref=').length - 1
		// one mount: the onboarding (Get started, redeem, and the requireBeamioTagCreate path all open this same screen)
		expect(mounts).toBe(1)
		const close = src.indexOf('close={qr => {')
		expect(close).toBeGreaterThan(-1)
		const window = src.slice(close, close + 400)
		expect(window).toContain('onNewAccountCreated?.()')
		expect(window.indexOf('onNewAccountCreated?.()')).toBeLessThan(window.indexOf('setQrDataUrl(qr.qrDataUrl)'))
	})
	it('the requireBeamioTagCreate path opens the same screen (reuseExistingKey) and so the same completion', () => {
		expect(src).toContain("if (requireBeamioTagCreate) {\n\t\t\t\t\tsetIsInitialEntry(true)\n\t\t\t\t\tsetSettingsOpen('CreateUsernamePinScreen')")
		expect(src).toContain('reuseExistingKey={requireBeamioTagCreate}')
	})
	it('both restore writes (recovery and onboarding restore) run inside the restore write window', () => {
		expect(src.split('runRestoreWrite(temp,').length - 1).toBe(2)
		// inside the onRestore handler no init runs outside runRestoreWrite
		const start = src.indexOf('onRestore={async')
		const end = src.indexOf('/>', start)
		const handler = src.slice(start, end)
		expect(start).toBeGreaterThan(-1)
		expect(handler).not.toMatch(/await init\(/)
		expect(src).toContain('onRestoreWriteStart?.()')
		expect(src).toContain('await onRestoreWriteEnd?.(ok, temp)')
	})
})
