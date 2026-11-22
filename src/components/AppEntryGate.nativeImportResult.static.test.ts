/**
 * @jest-environment node
 *
 * Spec item 41 (2026-11-16): the gate no longer consumes nativeImportResult. The import-return effect, the reload on
 * visibilitychange and the import result handler are deleted, and the gate never calls the native import page. Rewritten from the
 * source checks, which required that subscription; those assertions are superseded. Reads the source only.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('AppEntryGate does not consume nativeImportResult', () => {
	it('no subscription to the import result and no import-return state remain', () => {
		expect(src).not.toMatch(/onNativeImportResult/)
		expect(src).not.toMatch(/awaitingImportReturn/)
		expect(src).not.toMatch(/nativeImportResult/)
	})

	it('the gate does not open the import page or send nativeImportOpen', () => {
		expect(src).not.toMatch(/openNativeKeyImport/)
		expect(src).not.toMatch(/nativeImportOpen/)
	})
})
