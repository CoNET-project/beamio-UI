/**
 * @jest-environment node
 *
 * 0.53.52 (owner approval 2026-11-25): silent deletion of a private-key-only page record. Compare and delete: only a plain record with a private key and no
 * mnemonic at all goes; everything else, and every read failure, is left as it is. Real PouchDB code path on an in-memory test double. SYNTHETIC values only.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({ argon2idAsync: () => { throw new Error('argon2 must not run here') } }))
jest.mock('./idbBlobCompat', () => ({ ...jest.requireActual('./idbBlobCompat'), idbBlobCompatReady: async () => 'ok' }))
jest.mock('./shellContext', () => ({ isShellContext: () => false }))

type Doc = { _id: string; _rev: string; title?: string }
// the in-memory PouchDB: get with revisions, remove(doc) by revision, switches for read failure, hang, conflict and a delete that does not take effect
jest.mock('pouchdb', () => {
	const dbs = new Map<string, Map<string, Doc>>()
	function PouchDB(name: string) {
		if (!dbs.has(name)) dbs.set(name, new Map())
		const docs = dbs.get(name)!
		const g = globalThis as { __pouch?: { failGet?: boolean; hangGet?: boolean; conflictOnRemove?: boolean; keepOnRemove?: boolean; removes: number } }
		return {
			get: async (id: string) => {
				if (g.__pouch?.hangGet) return new Promise(() => undefined)
				if (g.__pouch?.failGet) throw new Error('idb_broken')
				const d = docs.get(id)
				if (!d) {
					const e: { status?: number; name?: string } = new Error('missing')
					e.status = 404
					e.name = 'not_found'
					throw e
				}
				return { ...d }
			},
			put: async (doc: Doc) => {
				docs.set(doc._id, { ...doc, _rev: `${Number(docs.get(doc._id)?._rev.split('-')[0] ?? 0) + 1}-t` })
				return { ok: true }
			},
			remove: async (doc: Doc) => {
				g.__pouch!.removes += 1
				if (g.__pouch?.conflictOnRemove) {
					const e: { status?: number; name?: string } = new Error('conflict')
					e.status = 409
					e.name = 'conflict'
					throw e
				}
				if (g.__pouch?.keepOnRemove) return { ok: true }
				const cur = docs.get(doc._id)
				if (cur && cur._rev !== doc._rev) {
					const e: { status?: number; name?: string } = new Error('conflict')
					e.status = 409
					e.name = 'conflict'
					throw e
				}
				docs.delete(doc._id)
				return { ok: true }
			},
			close: async () => undefined,
		}
	}
	return { __esModule: true, default: PouchDB, __dbs: dbs }
})

const EOA_LOWER = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const EOA_MIXED = '0x9858EfFD232B4033E47D90003d41eC34EcaEDa94'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
const keyOnly = (keyID = EOA_MIXED) => ({ isReady: true, profiles: [{ keyID, privateKeyArmor: `0x${'11'.repeat(32)}`, chats: [{ x: 1 }] }] })
const withPhrase = () => ({ mnemonicPhrase: 'test test test test test test test test test test test junk', isReady: true, profiles: [{ keyID: EOA_LOWER, privateKeyArmor: `0x${'11'.repeat(32)}` }] })

describe('purgeKeyOnlyPageRecord', () => {
	let mod: typeof import('./beamio')
	let dbs: Map<string, Map<string, Doc>>
	const g = globalThis as { __pouch?: { failGet?: boolean; hangGet?: boolean; conflictOnRemove?: boolean; keepOnRemove?: boolean; removes: number }; caches?: unknown }
	const db = () => [...dbs.values()][0]
	const seed = (id: string, title: string) => {
		if (!dbs.size) dbs.set('conet', new Map())
		;[...dbs.values()][0].set(id, { _id: id, _rev: '1-seed', title })
	}
	const initTitle = () => db()?.get('init')?.title
	beforeAll(() => {
		const { webcrypto } = require('crypto')
		if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
		const util = require('util')
		;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
		;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
		mod = require('./beamio')
		dbs = require('pouchdb').__dbs
	})
	beforeEach(() => {
		dbs.clear()
		g.__pouch = { removes: 0 }
		g.caches = undefined
	})

	it('a plain key-only record is deleted: the init document is gone, its wallet is returned in lower case, and meta is not touched', async () => {
		seed('init', b64(keyOnly()))
		seed('meta', JSON.stringify({ passcode: false }))
		const r = await mod.purgeKeyOnlyPageRecord()
		expect(r).toEqual({ kind: 'deleted', eoa: EOA_LOWER })
		expect(initTitle()).toBeUndefined()
		expect(db().get('meta')?.title).toBe(JSON.stringify({ passcode: false }))
	})

	it('the cache copy of the record goes too (only that entry)', async () => {
		seed('init', b64(keyOnly()))
		const deleted: string[] = []
		g.caches = { open: async () => ({ delete: async (req: { url: string }) => { deleted.push(req.url); return true } }) }
		;(globalThis as { Request?: unknown }).Request ??= class { url: string; constructor(u: string) { this.url = u } }
		const r = await mod.purgeKeyOnlyPageRecord()
		expect(r.kind).toBe('deleted')
		// the Cache API is only a migration backup: a context without a CACHE_WALLET_URL sends nothing, a context with it deletes exactly that entry
		expect(deleted.length).toBeLessThanOrEqual(1)
	})

	it('no page record: absent, nothing to delete', async () => {
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'absent' })
	})

	it('a keyID that is not an address still deletes (the wallet is returned empty)', async () => {
		seed('init', b64(keyOnly('not-an-address')))
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'deleted', eoa: '' })
	})

	describe('negative: nothing is deleted', () => {
		const untouched = async (title: string, expected: string) => {
			seed('init', title)
			const r = await mod.purgeKeyOnlyPageRecord()
			expect(r.kind).toBe(expected)
			expect(initTitle()).toBe(title)
			expect(g.__pouch?.removes).toBe(0)
		}
		it('a record with a mnemonic (a valid legacy account): not_key_only, bytes unchanged, no remove call', async () => {
			await untouched(b64(withPhrase()), 'not_key_only')
		})
		it('a mnemonic field that is not a plain string (a future format or an envelope): not_key_only', async () => {
			await untouched(b64({ ...keyOnly(), mnemonicPhrase: { v: 3, ct: 'x' } }), 'not_key_only')
		})
		it('an address-only record (no private key): not_key_only', async () => {
			await untouched(b64({ isReady: true, profiles: [{ keyID: EOA_LOWER }] }), 'not_key_only')
		})
		it('a record with no profiles: not_key_only', async () => {
			await untouched(b64({ isReady: true, profiles: [] }), 'not_key_only')
		})
		it('an unparseable record: not_key_only (never deleted on a guess)', async () => {
			await untouched('this is not a wallet record', 'not_key_only')
		})
		it('a wrapped record anywhere in the record: not_key_only', async () => {
			await untouched(b64({ ...keyOnly(), profiles: [{ keyID: EOA_LOWER, privateKeyArmor: `0x${'11'.repeat(32)}`, wrap: { v: 3, mode: 'passcode', salt: 's', iv: 'i', ct: 'x', eoa: EOA_LOWER } }] }), 'not_key_only')
		})
	})

	it('the read fails: unknown, the record is untouched', async () => {
		seed('init', b64(keyOnly()))
		g.__pouch!.failGet = true
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'unknown' })
		g.__pouch!.failGet = false
		expect(initTitle()).toBe(b64(keyOnly()))
		expect(g.__pouch?.removes).toBe(0)
	})

	it('the read never answers: unknown after the 5 s timeout, the record is untouched', async () => {
		seed('init', b64(keyOnly()))
		g.__pouch!.hangGet = true
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'unknown' })
		g.__pouch!.hangGet = false
		expect(initTitle()).toBe(b64(keyOnly()))
		expect(g.__pouch?.removes).toBe(0)
	}, 20_000)

	it('the record changed between the read and the remove (a conflict): failed, and the newer record is kept', async () => {
		seed('init', b64(keyOnly()))
		g.__pouch!.conflictOnRemove = true
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'failed' })
		expect(initTitle()).toBe(b64(keyOnly()))
	})

	it('the remove answers ok but the record is still there: failed, never reported as deleted', async () => {
		seed('init', b64(keyOnly()))
		g.__pouch!.keepOnRemove = true
		expect(await mod.purgeKeyOnlyPageRecord()).toEqual({ kind: 'failed' })
		expect(initTitle()).toBe(b64(keyOnly()))
	})
})
