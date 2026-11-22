/**
 * Storage really unavailable: the probe reports storage_unavailable, nothing is installed, and the local-wallet read reports
 * unavailable (never onboarding, never a delete). Source-level pins on the read path, plus the probe outcome. SYNTHETIC values only.
 */
import { runIdbBlobProbe } from './idbBlobCompat'
import { readFileSync } from 'fs'
import { join } from 'path'

const isBlob = (v: unknown) => typeof Blob !== 'undefined' && v instanceof Blob

describe('storage really unavailable: nothing is installed and the gate stays on unavailable', () => {
	it('open fails: storage_unavailable, no shim, no Blob write attempted', async () => {
		const install = jest.fn(() => true)
		const newBlob = jest.fn(() => new Blob(['']))
		const idb = { open: () => { const r: Record<string, unknown> = {}; setTimeout(() => (r.onerror as () => void)?.(), 0); return r }, deleteDatabase: () => ({}) } as unknown as IDBFactory
		expect(await runIdbBlobProbe({ idb, isBlob, newBlob, install })).toBe('storage_unavailable')
		expect(install).not.toHaveBeenCalled()
		expect(newBlob).not.toHaveBeenCalled()
	})

	it('the read path returns unavailable (indexeddb) before any PouchDB open when the probe says storage_unavailable, and never onboards', () => {
		const beamio = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
		const at = beamio.indexOf('const blobCompat = await idbBlobCompatReady()')
		expect(at).toBeGreaterThan(0)
		const next = beamio.slice(at, at + 400)
		expect(next).toContain("if (blobCompat === 'storage_unavailable') return { status: 'unavailable', reason: 'indexeddb' }")
		// the early unavailable return comes before the first PouchDB( open in the same block
		const unavailableAt = next.indexOf("return { status: 'unavailable', reason: 'indexeddb' }")
		const pouchAt = next.indexOf('PouchDB(')
		expect(unavailableAt).toBeGreaterThan(0)
		expect(pouchAt).toBeGreaterThan(unavailableAt)
		expect(next).not.toContain("status: 'empty'")
	})

	it('a probe_inconclusive result is not turned into an early return: only storage_unavailable is, so a hang runs the original gate timeout', () => {
		const beamio = readFileSync(join(__dirname, 'beamio.ts'), 'utf8')
		expect(beamio.split("blobCompat === 'storage_unavailable'").length - 1).toBe(1)
		expect(beamio).not.toContain("'probe_inconclusive'")
		expect(beamio).not.toMatch(/blobCompat === 'probe_inconclusive'/)
	})

	it('the probe never deletes wallet data: its only deletion is its own one-off database name', () => {
		const src = readFileSync(join(__dirname, 'idbBlobCompat.ts'), 'utf8')
		const deletes = src.split('deleteDatabase(').slice(1)
		expect(deletes.length).toBe(1)
		expect(src).toContain("export const BLOB_PROBE_DB_NAME = 'beamio-idb-blob-probe-v1'")
		expect(src).toContain('idb.deleteDatabase(BLOB_PROBE_DB_NAME)')
	})
})
