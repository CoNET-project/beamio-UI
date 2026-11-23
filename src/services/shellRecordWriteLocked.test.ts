/**
 * @jest-environment node
 *
 * HC-LOCK L-WRITE (v10 §3.2 shellRecordWrite): a locked write is named shell_record_locked (classified native_locked),
 * never native_unavailable, and the write path keeps the change for after the unlock.
 */
import { parseShellRecordWrite, shellRecordWrite, writeFailureDisposition } from './shellRecordStore'
import { shellStorageErrorReason } from './shellStoreWait'
import * as fs from 'fs'
import * as path from 'path'

describe('shellRecordWrite locked (L-WRITE)', () => {
	it('an envelope error locked parses to shell_record_locked', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: false, error: 'locked' })).toEqual({ status: 'error', reason: 'shell_record_locked' })
	})

	it('the locked write reason is classified as native_locked, not native_record', () => {
		expect(shellStorageErrorReason('shell_record_locked')).toBe('native_locked')
	})

	it('an envelope refusal keeps its error code (new semantics, 20ba920); an envelope without a string error is native_unavailable; ok still parses', () => {
		// the product did not regress: an unknown envelope code is retried as before (disposition 'retry', the same as native_unavailable)
		expect(parseShellRecordWrite({ type: 'ack', ok: false, error: 'something' })).toEqual({ status: 'error', reason: 'something' })
		expect(writeFailureDisposition('something')).toBe('retry')
		expect(parseShellRecordWrite({ type: 'ack', ok: false })).toEqual({ status: 'error', reason: 'native_unavailable' })
		expect(parseShellRecordWrite({ type: 'ack', ok: true, result: { code: 'ok', rev: 3 } })).toEqual({ status: 'ok', rev: 3 })
	})
	it('a known refusal from the envelope is never retried (bad_request, origin_refused, pgp_private_in_payload)', () => {
		for (const error of ['bad_request', 'origin_refused', 'pgp_private_in_payload']) {
			expect(writeFailureDisposition((parseShellRecordWrite({ type: 'ack', ok: false, error }) as { reason: string }).reason)).toBe('refused')
		}
	})

	it('the write path defers the change on a locked write (static: the deferWrite call precedes the throw)', () => {
		const src = fs.readFileSync(path.join(__dirname, 'shellRecordStore.ts'), 'utf8')
		const at = src.indexOf("if (out.status === 'failed' && out.reason === 'shell_record_locked') {")
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 200)).toContain('deferWrite(writeOps, null)')
	})

	it('shellRecordWrite is exported', () => {
		expect(typeof shellRecordWrite).toBe('function')
	})
})
