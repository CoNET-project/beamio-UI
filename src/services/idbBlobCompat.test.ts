/**
 * Narrow Blob compatibility shim (2026-11-18). Synthetic values only; no wallet data is touched.
 */
import { BLOB_PROBE_DB_NAME, installDetectBlobShim, makeDetectBlobPutShim, runIdbBlobProbe, POUCH_BLOB_PROBE_STORE } from './idbBlobCompat'

const isBlob = (v: unknown) => typeof Blob !== 'undefined' && v instanceof Blob

describe('the shim intercepts only the PouchDB probe store with a Blob value', () => {
	it('a Blob put into detect-blob-support throws DataCloneError synchronously and never reaches the original put', () => {
		const original = jest.fn(() => ({}) as IDBRequest)
		const shim = makeDetectBlobPutShim(original as never, isBlob)
		const fakeStore = { name: POUCH_BLOB_PROBE_STORE } as unknown as IDBObjectStore
		expect(() => shim.call(fakeStore, new Blob(['']), 'key')).toThrow(expect.objectContaining({ name: 'DataCloneError' }))
		expect(original).not.toHaveBeenCalled()
	})

	it('every other put is passed through unchanged (other store, non-Blob value, same store with a non-Blob)', () => {
		const original = jest.fn((..._args: unknown[]) => ({ passed: true }) as unknown as IDBRequest)
		const shim = makeDetectBlobPutShim(original as never, isBlob)
		const otherStore = { name: 'document-store' } as unknown as IDBObjectStore
		const probeStore = { name: POUCH_BLOB_PROBE_STORE } as unknown as IDBObjectStore
		const blob = new Blob([''])
		expect(shim.call(otherStore, blob, 'k')).toEqual({ passed: true })
		expect(shim.call(otherStore, 'text', 'k')).toEqual({ passed: true })
		expect(shim.call(probeStore, 'text', 'k')).toEqual({ passed: true })
		expect(original).toHaveBeenCalledTimes(3)
		expect(original.mock.calls[0]).toEqual([blob, 'k'])
	})

	it('installDetectBlobShim patches the prototype once and is idempotent', () => {
		const put = jest.fn(() => ({}) as IDBRequest)
		const target = { prototype: { put } as unknown as IDBObjectStore }
		expect(installDetectBlobShim(target)).toBe(true)
		const patched = target.prototype.put
		expect(patched).not.toBe(put)
		expect(installDetectBlobShim(target)).toBe(false)
		expect(target.prototype.put).toBe(patched)
	})
})

type Fake = {
	open?: 'ok' | 'error' | 'hang'
	put?: 'ok' | 'error' | 'throw' | 'hang'
}

/** A minimal IDBFactory double for the probe. Only the calls the probe makes are modelled. */
function fakeIdb(cfg: Fake) {
	const deleted: string[] = []
	const factory = {
		open(name: string) {
			const req: Record<string, unknown> & { result?: unknown; error?: unknown } = {}
			const store = { put: () => {
				if (cfg.put === 'throw') throw new DOMException('no', 'DataCloneError')
				const r: Record<string, unknown> = {}
				if (cfg.put === 'ok') setTimeout(() => (r.onsuccess as () => void)?.(), 0)
				if (cfg.put === 'error') setTimeout(() => { (r.onerror as (e: { preventDefault(): void }) => void)?.({ preventDefault() {} }) }, 0)
				return r
			} }
			const db = {
				objectStoreNames: { contains: () => true },
				createObjectStore: () => store,
				transaction: () => ({ objectStore: () => store }),
				close: () => undefined,
			}
			req.result = db
			setTimeout(() => {
				if (cfg.open === 'error') (req.onerror as () => void)?.()
				else if (cfg.open === 'ok') (req.onsuccess as () => void)?.()
			}, 0)
			return req as unknown as IDBOpenDBRequest
		},
		deleteDatabase(name: string) {
			deleted.push(name)
			const r: Record<string, unknown> = {}
			setTimeout(() => (r.onsuccess as () => void)?.(), 0)
			return r as unknown as IDBOpenDBRequest
		},
	}
	return { factory, deleted }
}

const deps = (cfg: Fake) => {
	const { factory, deleted } = fakeIdb(cfg)
	const install = jest.fn(() => true)
	return { deps: { idb: factory as unknown as IDBFactory, isBlob, newBlob: () => new Blob(['']), install }, install, deleted }
}

describe('the probe decides in a separate one-off database (no change when Blob writes work)', () => {
	it('Blob write succeeds: blob_supported, nothing installed, the probe database is removed', async () => {
		const d = deps({ open: 'ok', put: 'ok' })
		expect(await runIdbBlobProbe(d.deps)).toBe('blob_supported')
		expect(d.install).not.toHaveBeenCalled()
		expect(d.deleted).toEqual([BLOB_PROBE_DB_NAME])
	})

	it('Blob write throws synchronously: shim_installed', async () => {
		const d = deps({ open: 'ok', put: 'throw' })
		expect(await runIdbBlobProbe(d.deps)).toBe('shim_installed')
		expect(d.install).toHaveBeenCalledTimes(1)
	})

	it('Blob write errors: shim_installed', async () => {
		const d = deps({ open: 'ok', put: 'error' })
		expect(await runIdbBlobProbe(d.deps)).toBe('shim_installed')
		expect(d.install).toHaveBeenCalledTimes(1)
	})

	it('Blob write hangs past the limit: probe_inconclusive, shim NOT installed, never storage_unavailable (2026-11-18 rule)', async () => {
		// the put never answers (the fake returns an inert request for "hang": no callback fires)
		const d = deps({ open: 'ok', put: 'hang' })
		const out = await runIdbBlobProbe(d.deps)
		expect(out).toBe('probe_inconclusive')
		expect(out).not.toBe('shim_installed')
		expect(out).not.toBe('storage_unavailable')
		expect(d.install).not.toHaveBeenCalled()
	}, 10_000)

	it('a hang is a separate result from a failure: an error still installs the shim, a hang does not', async () => {
		const failed = deps({ open: 'ok', put: 'error' })
		expect(await runIdbBlobProbe(failed.deps)).toBe('shim_installed')
		const hung = deps({ open: 'ok', put: 'hang' })
		expect(await runIdbBlobProbe(hung.deps)).toBe('probe_inconclusive')
		expect(failed.install).toHaveBeenCalledTimes(1)
		expect(hung.install).not.toHaveBeenCalled()
	}, 10_000)
})

describe('storage that is really unavailable is not papered over (nothing installed)', () => {
	it('indexedDB.open fails: storage_unavailable, no shim', async () => {
		const d = deps({ open: 'error' })
		expect(await runIdbBlobProbe(d.deps)).toBe('storage_unavailable')
		expect(d.install).not.toHaveBeenCalled()
	})

	it('indexedDB.open hangs past the limit: storage_unavailable, no shim', async () => {
		const { factory } = fakeIdb({ open: 'hang' })
		const install = jest.fn(() => true)
		const out = await runIdbBlobProbe({ idb: factory as unknown as IDBFactory, isBlob, newBlob: () => new Blob(['']), install })
		expect(out).toBe('storage_unavailable')
		expect(install).not.toHaveBeenCalled()
	}, 10_000)

	it('no IndexedDB at all: no_idb, no shim', async () => {
		const install = jest.fn(() => true)
		expect(await runIdbBlobProbe({ idb: undefined, isBlob, newBlob: () => new Blob(['']), install })).toBe('no_idb')
		expect(install).not.toHaveBeenCalled()
	})
})

describe('static pins: the local-wallet database is opened only after the probe, and an unavailable open is reported as unavailable', () => {
	const fs = require('fs') as typeof import('fs')
	const path = require('path') as typeof import('path')
	const beamio = fs.readFileSync(path.join(__dirname, 'beamio.ts'), 'utf8')
	it('every PouchDB open in beamio.ts is preceded by the probe await', () => {
		const opens = beamio.split('PouchDB(localDatabaseName').length - 1
		const awaits = beamio.split('await idbBlobCompatReady()').length - 1
		expect(opens).toBe(5)
		expect(awaits).toBe(5)
	})
	it('the read path maps storage_unavailable to the same unavailable reason as a failed open', () => {
		expect(beamio).toContain("if (blobCompat === 'storage_unavailable') return { status: 'unavailable', reason: 'indexeddb' }")
	})
})
