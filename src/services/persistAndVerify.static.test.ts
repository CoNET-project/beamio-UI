/**
 * (Chat SDK): persistAndVerifyLocalWallet re-reads with a probe, which does not move the copy basis.
 * The page's held change reaches the copy through that read (shellRecordRead returns the page's view). Read from source; a removed guard fails.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('persistAndVerifyLocalWallet re-reads with a probe and does not move the copy basis', () => {
	const beamio = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')

	it('the re-read is a probe read', () => {
		const at = beamio.indexOf('export const persistAndVerifyLocalWallet')
		expect(at).toBeGreaterThan(-1)
		const block = beamio.slice(at, at + 3000)
		expect(block).toContain('readStorageWithStatus(true, { probe: true })')
	})
})
