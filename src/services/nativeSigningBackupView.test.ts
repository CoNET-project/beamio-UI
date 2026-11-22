/**
 * @jest-environment node
 *
 * (Android review): no raw native reason is shown; unknown_command and not_supported give the neutral update copy. NB-1…NB-4
 * are my own naming. The two screens are checked statically (no raw reason passed to the text).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { backupViewErrorKey } from './nativeSigning'

describe('backup view error copy (NB)', () => {
	it('NB-1: unknown_command and not_supported give the update copy', () => {
		expect(backupViewErrorKey('unknown_command')).toBe('native_backup_view_unsupported')
		expect(backupViewErrorKey('not_supported')).toBe('native_backup_view_unsupported')
	})

	it('NB-2: any other reason gives the neutral failure copy (the raw reason is never the text)', () => {
		expect(backupViewErrorKey('timeout')).toBe('native_backup_view_failed')
		expect(backupViewErrorKey('kind_not_allowed')).toBe('native_backup_view_failed')
		expect(backupViewErrorKey('some raw native text')).toBe('native_backup_view_failed')
	})

	it('NB-3: PrivateKey.tsx shows the mapped copy, never the raw reason', () => {
		const src = readFileSync(join(__dirname, '..', 'components', 'Setting', 'PrivateKey', 'PrivateKey.tsx'), 'utf8')
		expect(src).toContain('setErrorText(tu(backupViewErrorKey(out.reason)))')
		expect(src).not.toContain('setErrorText(out.reason)')
	})

	it('NB-4: recoverQR.tsx shows the mapped copy, never the raw reason', () => {
		const src = readFileSync(join(__dirname, '..', 'components', 'Setting', 'PrivateKey', 'recoverQR.tsx'), 'utf8')
		expect(src).toContain('setErrorText(tu(backupViewErrorKey(out.reason)))')
		expect(src).not.toContain('setErrorText(out.reason)')
	})
})
