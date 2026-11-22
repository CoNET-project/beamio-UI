/**
 * With the shim installed (the probe-failed case), only the probe-store Blob write is intercepted. Every other put is passed through
 * untouched, so the wallet reads and writes (get('init') and the document puts) keep their original behaviour. Synthetic values only.
 * The real-engine proof (PouchDB setup completing and get('init') returning, WebKit short-lived context) is recorded in the receipt
 * (TRACE-setup-webkit-ephemeral-bbf147c.mjs); jsdom cannot run PouchDB's IndexedDB setup (a control run without the shim fails the same way).
 */
import { installDetectBlobShim, makeDetectBlobPutShim } from './idbBlobCompat'

const isBlob = (v: unknown) => typeof Blob !== 'undefined' && v instanceof Blob

describe('probe failed but storage usable: the shim does not touch the wallet paths', () => {
	it('a document put into the wallet store (title string, key init) reaches the original put with its arguments unchanged', () => {
		const original = jest.fn((..._a: unknown[]) => ({ req: 'doc' }) as unknown as IDBRequest)
		const shim = makeDetectBlobPutShim(original as never, isBlob)
		const docStore = { name: 'document-store' } as unknown as IDBObjectStore
		const out = shim.call(docStore, { _id: 'init', title: 'SYNTHETIC-PAYLOAD' }, undefined)
		expect(out).toEqual({ req: 'doc' })
		expect(original).toHaveBeenCalledTimes(1)
		expect(original.mock.calls[0]).toEqual([{ _id: 'init', title: 'SYNTHETIC-PAYLOAD' }, undefined])
	})

	it('a Blob written to any store other than the probe store is passed through (no DataCloneError)', () => {
		const original = jest.fn((..._a: unknown[]) => ({ req: 'attach' }) as unknown as IDBRequest)
		const shim = makeDetectBlobPutShim(original as never, isBlob)
		const attachStore = { name: 'attach-store' } as unknown as IDBObjectStore
		expect(() => shim.call(attachStore, new Blob(['x']), 'a1')).not.toThrow()
		expect(original).toHaveBeenCalledTimes(1)
	})

	it('installing after the shim is already there does not wrap it again (the wallet put is still a single call)', () => {
		const put = jest.fn(() => ({}) as IDBRequest)
		const target = { prototype: { put } as unknown as IDBObjectStore }
		installDetectBlobShim(target)
		const once = target.prototype.put
		installDetectBlobShim(target)
		expect(target.prototype.put).toBe(once)
	})
})
