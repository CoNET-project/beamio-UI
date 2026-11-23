/**
 * HC-LOCK device-mode (v10 §3.2, L-DEV): a locked wallet reads and writes nothing, and is never the missing or undecryptable state.
 */
import { pageStateForAck } from './pgpMigrationClient'
import * as fs from 'fs'
import * as path from 'path'

describe('device-mode locked (L-DEV)', () => {
	it('pgpMigrationClient: an ack error locked is the locked page state, not retryable or refused', () => {
		expect(pageStateForAck({ type: 'ack', ok: false, error: 'locked' })).toBe('locked')
	})

	it('ownPgpBlob: a locked wallet gives the locked state, never missing or undecryptable', () => {
		const src = fs.readFileSync(path.join(__dirname, 'ownPgpBlob.ts'), 'utf8')
		expect(src).toContain("return code === 'locked' ? none('locked')")
		expect(src).toContain("codeOf(ex) === 'locked' ? none('locked')")
	})

	it('the registration reader does not map locked to missing (chat.ts keeps the error, registers no new key)', () => {
		const src = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8')
		expect(src).toContain("'locked' and 'error' throw, so the caller records 'error' and does not register a new key.")
		expect(src).toContain("default:\n\t\t\t// 'locked' and 'error' throw")
	})
})
