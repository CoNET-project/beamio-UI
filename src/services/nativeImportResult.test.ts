/**
 * Spec r2.3 item 41 (2026-11-16): the native import result (Y.95, nativeImportResult) is retired together with the import screen. The
 * module nativeImportResult.ts is deleted and nothing in the PWA consumes the result or tracks the reqId of an import. Rewritten from the
 * codes-and-eoa rule tests: those assertions are superseded, and the entry is asserted absent. SYNTHETIC; no key material.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import * as nativeKeyState from './nativeKeyState'

describe('the native import result is retired (spec r2.3 item 41)', () => {
	it('the result module is deleted', () => {
		expect(existsSync(join(__dirname, 'nativeImportResult.ts'))).toBe(false)
	})

	it('nativeKeyState exports no import opener and no import reqId tracker', () => {
		expect(nativeKeyState).not.toHaveProperty('openNativeKeyImport')
		expect(nativeKeyState).not.toHaveProperty('lastOpenedImportReqId')
		expect(nativeKeyState).not.toHaveProperty('NATIVE_IMPORT_OPEN')
	})
})
