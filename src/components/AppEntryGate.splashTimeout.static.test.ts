/**
 * S25 (2026-11-15): an undecided start at the 12 s splash deadline shows the native retry state in a shell, never the
 * unreadable-store screen, and never judges an account. Static check of the timer branch.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('splash deadline in a shell', () => {
	it('shows the native retry state for an undecided shell start, not the storage-unavailable reason', () => {
		const block = src.slice(src.indexOf('const splashTimer = window.setTimeout'), src.indexOf('}, SPLASH_FORCE_DISMISS_MS)'))
		// 2026-11-22: in the shell the undecided deadline is a background wait (no screen, no button), not the retired screen.
		expect(block).not.toContain('NATIVE_RETRY_SCREEN')
		expect(block).toContain("startupWait('splash deadline: start undecided (shell background, no screen)', 'native_retry_deadline')")
		expect(block.indexOf("startupWait('splash deadline")).toBeLessThan(block.indexOf("handleStorageUnavailable('timeout')"))
	})

	it('does not create or overwrite an account in the timer branch', () => {
		const block = src.slice(src.indexOf('const splashTimer = window.setTimeout'), src.indexOf('}, SPLASH_FORCE_DISMISS_MS)'))
		expect(block).not.toMatch(/goOnboarding|writeInit|persistInitRecord|shellRecordWrite/)
	})
})

describe('splash deadline after a decision', () => {
	it('the release branch is a splash-only dismissal, logged as info (not a forced dismissal)', () => {
		const start = src.indexOf("if (action === 'release') {")
		const block = src.slice(start, src.indexOf('}', src.indexOf('return', start)) + 1)
		expect(block).toContain("publishNativePwaLog('info'")
		expect(block).not.toContain('force-dismiss')
		expect(block).toMatch(/splash hidden, nothing else changed/)
	})
})
