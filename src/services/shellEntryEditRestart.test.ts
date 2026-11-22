/**
 * @jest-environment node
 */
/**
 * Entry-level regression (2026-11-20, independent review 09c734b6, item 1 (1)): an old-store entry, an edit, a restart, at the level
 * of checkStorageWithStatus (the production start read) and persistInitRecord (the production write), with the REAL shell record store and
 * the REAL deferred-write gate. Only the I/O boundaries are doubles: the native record transport (a fake native that keeps its own wallet
 * fields), the PouchDB old store, and the page storage (window.localStorage). Synthetic values only: the public BIP-39 test vector.
 */
import { ethers } from 'ethers'

// node environment: the webcrypto and the text codecs the vault uses
{
	const { webcrypto } = require('crypto')
	const util = require('util')
	if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
	;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
	;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
}
jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
jest.mock('@/services/argon2WorkerBridge', () => ({
	argon2idAsync: async (password: Uint8Array, salt: Uint8Array, opts: { dkLen: number }) => {
		const { pbkdf2Sync } = require('crypto')
		return new Uint8Array(pbkdf2Sync(Buffer.from(password), Buffer.from(salt), 1, opts.dkLen, 'sha256'))
	},
}))
jest.mock('./idbBlobCompat', () => ({ ...jest.requireActual('./idbBlobCompat'), idbBlobCompatReady: async () => 'ok' }))
jest.mock('./shellContext', () => ({ isShellContext: () => (globalThis as { __shellMode?: boolean }).__shellMode === true }))
// the old store: an in-memory PouchDB whose documents live on globalThis (they survive a module reset, as the page storage does)
jest.mock('pouchdb', () => {
	function PouchDB(name: string) {
		const g = globalThis as { __pouch?: Map<string, Map<string, { _id: string; _rev: string; title?: string }>> }
		if (!g.__pouch) g.__pouch = new Map()
		if (!g.__pouch.has(name)) g.__pouch.set(name, new Map())
		const docs = g.__pouch.get(name)!
		return {
			get: async (id: string) => {
				const d = docs.get(id)
				if (!d) {
					const e: { status?: number; name?: string } = new Error('missing')
					e.status = 404
					e.name = 'not_found'
					throw e
				}
				return { ...d }
			},
			put: async (doc: { _id: string; _rev?: string; title?: string }) => {
				const cur = docs.get(doc._id)
				if (cur && doc._rev !== cur._rev) {
					const e: { status?: number; name?: string } = new Error('conflict')
					e.status = 409
					e.name = 'conflict'
					throw e
				}
				const rev = `${cur ? Number(cur._rev.split('-')[0]) + 1 : 1}-m`
				docs.set(doc._id, { _id: doc._id, _rev: rev, title: doc.title })
				return { ok: true, id: doc._id, rev }
			},
			remove: async (id: string) => void docs.delete(id),
			close: async () => undefined,
		}
	}
	return { __esModule: true, default: PouchDB }
})
// the native record transport: a fake native that keeps its own wallet fields (the page never sends them)
jest.mock('./shellRecordTransport', () => {
	const actual = jest.requireActual('./shellRecordTransport')
	return {
		...actual,
		sendShellRecordCommand: async (cmd: Record<string, any>) => {
			const n = (globalThis as { __fakeNative?: Record<string, any> }).__fakeNative as Record<string, any>
			if (cmd.type === 'shellRecordRead') {
				if (n.record === undefined) return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'absent' } } }
				return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'ok', record: JSON.parse(JSON.stringify(n.record)) } } }
			}
			n.writes.push(JSON.parse(JSON.stringify(cmd.record)))
			if (n.record !== undefined && cmd.record.rev !== n.rev) {
				return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'conflict', currentRev: n.rev } } }
			}
			const next = JSON.parse(JSON.stringify(cmd.record))
			next.mnemonicPhrase = n.keys.mnemonicPhrase
			for (const p of next.profiles ?? []) {
				const k = (n.keys.profiles ?? []).find((x: Record<string, any>) => x.keyID === p.keyID)
				if (k) p.privateKeyArmor = k.privateKeyArmor
			}
			n.rev += 1
			next.rev = n.rev
			n.record = next
			return { kind: 'payload', payload: { type: 'ack', reqId: cmd.reqId, ok: true, result: { code: 'ok', rev: n.rev } } }
		},
	}
})
jest.mock('./walletEoaAddress', () => ({ readWalletEoaAddress: async () => ({ kind: 'address', eoa: (globalThis as { __keyId?: string }).__keyId }) }))

// the in-memory device key store (test double of the IndexedDB device store): a CryptoKey is kept by reference
const deviceStore = ((globalThis as { __deviceStore?: Map<string, unknown> }).__deviceStore ??= new Map<string, unknown>())
function installDeviceKeyShim(): void {
	const reqFor = (run: () => void) => {
		const r: { result?: unknown; onsuccess?: ((e: unknown) => void) | null } = {}
		queueMicrotask(() => {
			run()
			r.onsuccess?.({ target: r })
		})
		return r
	}
	const dbFor = (): Record<string, unknown> => ({
		objectStoreNames: { contains: () => true },
		createObjectStore: () => undefined,
		close: () => undefined,
		transaction: () => {
			const tx: { oncomplete?: (() => void) | null; onerror?: (() => void) | null; objectStore: () => unknown } = {
				oncomplete: null,
				onerror: null,
				objectStore: () => ({
					get: (key: string) => {
						const r: { result?: unknown; onsuccess?: ((e: unknown) => void) | null } = {}
						queueMicrotask(() => {
							r.result = deviceStore.get(key)
							r.onsuccess?.({ target: r })
						})
						return r
					},
					put: (value: unknown, key: string) => {
						const r: { onsuccess?: ((e: unknown) => void) | null } = {}
						queueMicrotask(() => {
							deviceStore.set(key, value)
							r.onsuccess?.({ target: r })
							tx.oncomplete?.()
						})
						return r
					},
				}),
			}
			return tx
		},
	})
	;(globalThis as { indexedDB?: unknown }).indexedDB = {
		open: (name: string) => {
			const req: { result?: unknown; onupgradeneeded?: (() => void) | null; onsuccess?: ((e: unknown) => void) | null; onerror?: (() => void) | null } = {}
			if (name !== 'beamio-vault-v1') {
				queueMicrotask(() => req.onerror?.())
				return req
			}
			req.result = dbFor()
			queueMicrotask(() => {
				req.onupgradeneeded?.()
				req.onsuccess?.({ target: req })
			})
			return req
		},
	}
	void reqFor
}

if (!(globalThis as { window?: unknown }).window) {
	// node env: a minimal window (location only), enough for the browser-side URL constants and the iOS bridge probe
	;(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' }, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }
}
const E0 = require('ethers')

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WALLET = ethers.Wallet.fromPhrase(PHRASE)
const KEY_ID = WALLET.address.toLowerCase()
const KEY_HEX = WALLET.privateKey

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** The page storage for the deferred intent (window.localStorage); the node test has none. */
function installPageStorage(): void {
	const g = globalThis as { __pageMem?: Map<string, string>; window?: unknown }
	if (!g.__pageMem) g.__pageMem = new Map()
	const mem = g.__pageMem
	g.window = {
		location: { origin: 'http://localhost' },
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => true,
		localStorage: {
			getItem: (k: string) => mem.get(k) ?? null,
			setItem: (k: string, v: string) => void mem.set(k, v),
			removeItem: (k: string) => void mem.delete(k),
		},
	}
}

describe('an old-store entry, an edit and a restart, through checkStorageWithStatus and persistInitRecord (real gate; I/O doubles only)', () => {
	beforeEach(() => {
		jest.resetModules()
		const g = globalThis as Record<string, any>
		g.__pouch = new Map()
		g.__pageMem = new Map()
		g.__shellMode = true
		g.__keyId = KEY_ID
		g.__fakeNative = { keys: { mnemonicPhrase: PHRASE, profiles: [{ keyID: KEY_ID, privateKeyArmor: KEY_HEX }] }, rev: 0, writes: [] }
		installPageStorage()
		installDeviceKeyShim()
		const legacy = { mnemonicPhrase: PHRASE, isReady: true, beamio: { firstName: 'old' }, profiles: [{ keyID: KEY_ID, userName: 'old-name' }] }
		const { encodeInitRaw } = require('./initRecordCodec')
		g.__pouch.set('conet', new Map([['init', { _id: 'init', _rev: '1-old', title: encodeInitRaw(legacy) }]]))
	})
	afterEach(() => {
		const g = globalThis as Record<string, any>
		delete g.window
	})

	it('the entry enters the old record; the edit is kept while the native record is absent; a restart keeps it; after the confirmed sync the edit is written natively', async () => {
		const g = globalThis as Record<string, any>
		const signer = require('./shellSessionSigner')
		const beamio = require('./beamio')
		const store = require('./shellRecordStore')
		const globals = require('@/utils/globals')
		signer.holdShellSessionFromPhrase(PHRASE, KEY_ID)

		// 1. the start read enters the old store (native absent); the write-back it schedules is held by the gate
		const start = await beamio.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		expect((start as { data: Record<string, any> }).data.profiles[0].userName).toBe('old-name')
		expect(g.__fakeNative.writes.length).toBe(0)

		// 2. the user edits; the save is held (the native key is not confirmed): nothing is written natively
		const edited = clone((start as { data: Record<string, any> }).data)
		edited.profiles[0].userName = 'edited-name'
		globals.setCoNET_Data(edited)
		await beamio.persistInitRecord(clone(edited))
		expect(g.__fakeNative.writes.length).toBe(0)
		expect(store.deferredWriteForTest()).not.toBeNull()

		// 3. restart: a fresh module graph; the old store and the page storage are unchanged; the intent is read back
		jest.resetModules()
		const signer2 = require('./shellSessionSigner')
		const beamio2 = require('./beamio')
		const store2 = require('./shellRecordStore')
		signer2.holdShellSessionFromPhrase(PHRASE, KEY_ID)
		expect(g.__pouch.get('conet')?.get('init')?._rev).toBe('1-old')
		const restart = await beamio2.checkStorageWithStatus()
		expect(restart.status).toBe('loaded') // the old store still enters on a shell start while the native record is absent
		expect(g.__fakeNative.writes.length).toBe(0)
		expect(store2.deferredWriteForTest()).not.toBeNull()

		// 4. the native sync of this account is confirmed: the held edit is written at once
		store2.allowFirstNativeWrite(KEY_ID)
		await store2.retryDeferredWriteNow()
		expect(g.__fakeNative.writes.length).toBe(1)
		expect(g.__fakeNative.record.profiles[0].userName).toBe('edited-name')
		expect(g.__fakeNative.record.mnemonicPhrase).toBe(PHRASE) // the native side keeps its own wallet fields

		// 5. the next start reads the native record of the same account (it is newer): the edit comes back
		const after = await beamio2.checkStorageWithStatus()
		expect(after.status).toBe('loaded')
		expect((after as { data: Record<string, any> }).data.profiles[0].userName).toBe('edited-name')
		// the old store was never rewritten
		expect(g.__pouch.get('conet')?.get('init')?._rev).toBe('1-old')
	})

	it('the old store is wiped and the native side has no record: the start is onboarding (the restore entry is there), nothing is written, and the chat identity create action is not eligible', async () => {
		const g = globalThis as Record<string, any>
		g.__pouch.set('conet', new Map())
		g.__deviceStore?.clear?.()
		const beamio = require('./beamio')
		const { pgpCreateEligible } = require('./pgpIdentityEligibility')
		const { nativeGenerateNewPgpKey } = require('./nativePgpRestore')
		const start = await beamio.checkStorageWithStatus()
		expect(start.status).toBe('empty')
		expect(g.__fakeNative.writes.length).toBe(0)
		expect(pgpCreateEligible(KEY_ID)).toBe(false)
		await expect(nativeGenerateNewPgpKey(KEY_ID)).resolves.toEqual({ ok: false, reason: 'not_eligible' })
	})
})
