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
		expect(block).toContain('showStorageUnavailable(NATIVE_RETRY_SCREEN)')
		expect(block.indexOf('showStorageUnavailable(NATIVE_RETRY_SCREEN)')).toBeLessThan(block.indexOf("handleStorageUnavailable('timeout')"))
	})

	it('does not create or overwrite an account in the timer branch', () => {
		const block = src.slice(src.indexOf('const splashTimer = window.setTimeout'), src.indexOf('}, SPLASH_FORCE_DISMISS_MS)'))
		expect(block).not.toMatch(/goOnboarding|writeInit|persistInitRecord|shellRecordWrite/)
	})
})
