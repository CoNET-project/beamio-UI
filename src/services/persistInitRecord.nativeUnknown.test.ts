/**
 * @jest-environment node
 */
import { holdShellSessionFromPhrase, releaseShellSessionSignerHold } from './shellSessionSigner'
import { hasPendingSync, takePendingSync } from './pendingSync'
import { isPersistFailed, clearPersistFailed } from './persistNoticeStatus'
import { runMigrationCore } from './chatLocalMigrationCore'
/**
 * Fix B: a shell save is never blocked by the native probe read. For every native answer the page copy is written and the save resolves;
 * an answer other than ok or absent leaves the native state unknown and marks a pending native sync. Synthetic values only.
 *
 * Persistence regression through the production persistInitRecord (0.53.39, independent review item 3), both paths:
 * - browser: the record goes to the PouchDB document 'init' (test double: an in-memory PouchDB);
 * - shell: the record goes to the native record store (test double: shellRecordWrite / shellRecordRead on an in-memory copy).
 * The device key is an in-memory CryptoKey (test double of the IndexedDB device store, which fake-indexeddb cannot hold). The KDF is the
 * test double. Synthetic values only: the public BIP-39 test phrases; no real account, no device, no credential.
 *
 * Criterion (a): the record read back through the production reader, JSON-normalised, equals the record before the
 * path, for every account. Storage metadata (*Wrap sibling fields) and an empty pgpKey object are left out of the comparison (see the
 * migration test for the finding).
 */
/* eslint-disable @typescript-eslint/no-var-requires */

jest.mock('@/workers/appDaemon/client', () => ({}))
jest.mock('@/workers/beamioTag/client', () => ({}))
jest.mock('@/services/chatWorkerBridge', () => ({}))
jest.mock('@/services/chatMediaWorkerBridge', () => ({}))
// the product sync to the shell (unit f3 follow-up): a recording double, so the product disable path can be seen to call it
// the first pwaWalletSync with the cipher (set passcode): a recording double whose reply is ok (completes the set)
jest.mock('./pwaWalletSyncTransport', () => ({
	...jest.requireActual('./pwaWalletSyncTransport'),
	sendPwaWalletSyncCipher: (command: string, seq: number, cipher: unknown, passcode?: string) => {
		const g = globalThis as { __cipherSyncCalls?: unknown[]; __cipherReply?: string }
		;(g.__cipherSyncCalls ??= []).push({ command, seq, cipher, passcode })
		return Promise.resolve({ code: g.__cipherReply ?? 'ok' })
	},
}))
jest.mock('./shellMnemonicSync', () => ({
	shellMnemonicSync: { sync: jest.fn(async () => ({ kind: 'unavailable', tx: 0 })) },
}))
// 模块加载桩：beamio.ts 静态导入 argon2WorkerBridge（含 import.meta，Jest 无法加载）。KDF 经 setMnemonicKdfForTest / setPasscodeKdfForTest 注入（见 beforeAll）。
jest.mock('@/services/argon2WorkerBridge', () => ({}))
// the production cooldown store is IndexedDB; this suite has none, so the cooldown record is the in-memory atomic store (test double)
jest.mock('./passcode/passcodeWrapStore', () => {
	const actual = jest.requireActual('./passcode/passcodeWrapStore')
	return {
		...actual,
		idbKeyValueDb: () => ((globalThis as { __cooldownDb?: unknown }).__cooldownDb ??= actual.memoryAtomicKeyValueDb()),
	}
})

// the in-memory PouchDB (the browser store's I/O boundary); the raw documents are reachable for seeding and inspection
jest.mock('pouchdb', () => {
	const dbs = new Map<string, Map<string, { _id: string; _rev: string; title?: string }>>()
	function PouchDB(name: string) {
		if (!dbs.has(name)) dbs.set(name, new Map())
		const docs = dbs.get(name)!
		return {
			get: async (id: string) => {
				const d = docs.get(id)
				if (!d) {
					const e: { status?: number; name?: string; message?: string } = new Error('missing')
					e.status = 404
					e.name = 'not_found'
					throw e
				}
				return { ...d }
			},
			put: async (doc: { _id: string; _rev?: string; title?: string }) => {
				if ((globalThis as { __pouchPutFail?: boolean }).__pouchPutFail) throw new Error('disk full')
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
			remove: async (id: string) => {
				docs.delete(id)
			},
			close: async () => undefined,
		}
	}
	return { __esModule: true, default: PouchDB, __dbs: dbs }
})

jest.mock('./idbBlobCompat', () => ({ ...jest.requireActual('./idbBlobCompat'), idbBlobCompatReady: async () => 'ok' }))

// the shell flag is a test switch (the production check reads the native bridge)
jest.mock('./shellContext', () => ({ isShellContext: () => (globalThis as { __shellMode?: boolean }).__shellMode === true }))

// the native account answer (walletEoaAddress): a per-case stub; default is a refusal (no channel in the test)
jest.mock('./walletEoaAddress', () => ({
	readWalletEoaAddress: async () => (globalThis as { __nativeEoa?: unknown }).__nativeEoa ?? { kind: 'refused', code: 'error' },
}))

// the native record store (the shell's I/O boundary). The write follows the real rule: the page copy goes through
// sanitizeForBridge + stripWalletFields (W-class and PGP private never sent, shellRecordStore.ts sanitizedCopy); the native
// side keeps its own W-class fields (mnemonicPhrase and profiles[].privateKeyArmor), merged below.
jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	const sanitizer = jest.requireActual('./shellRecordSanitizer')
	return {
		...actual,
		shellRecordWrite: async (data: unknown) => {
			const g = globalThis as { __shellStore?: Loose; __shellRev?: number }
			// the real write whitelist first (shellRecordStore buildShellRecordWriteCommand): a PGP public container or private material is refused
			const store = jest.requireActual('./shellRecordStore')
			const command = store.buildShellRecordWriteCommand(0, data as Loose, 0)
			;(globalThis as { __shellLastPayload?: unknown }).__shellLastPayload = JSON.parse(JSON.stringify(command.record))
			const sent = sanitizer.stripWalletFields(sanitizer.sanitizeForBridge(data)) as Loose
			const prev = g.__shellStore
			if (prev) {
				if (prev.mnemonicPhrase !== undefined) sent.mnemonicPhrase = prev.mnemonicPhrase
				for (const p of (sent.profiles ?? []) as Loose[]) {
					const q = ((prev.profiles ?? []) as Loose[]).find((x) => x.keyID === p.keyID)
					if (q && q.privateKeyArmor !== undefined) p.privateKeyArmor = q.privateKeyArmor
				}
			}
			g.__shellStore = JSON.parse(JSON.stringify(sent))
			g.__shellRev = (g.__shellRev ?? 0) + 1
			return { status: 'ok', rev: g.__shellRev }
		},
		shellRecordRead: async () => {
			const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __nativeAnswer?: unknown }
			if (g.__nativeAnswer !== undefined) return jest.requireActual('./shellRecordStore').parseShellRecordRead(g.__nativeAnswer as Record<string, any>)
			if (g.__shellStore === '__unknown__') return { status: 'error', reason: 'not_ready' } // a native read that did not answer
			if (g.__shellStore === undefined) return { status: 'absent' }
			return { status: 'ok', record: JSON.parse(JSON.stringify(g.__shellStore)), rev: g.__shellRev ?? 0, walletFieldsRedacted: false }
		},
		prepareShellFreshWrite: async () => ({ isolated: false }),
	}
})

type Loose = Record<string, any>

// the in-memory device key store (test double of the IndexedDB device store): a CryptoKey is kept by reference
const deviceStore = new Map<string, unknown>()
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
const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'


describe('native read replies: persistInitRecord completes whatever the native probe read answers (synthetic, parsed by the real parseShellRecordRead)', () => {
	let mod: Loose
	let globals: Loose
	let pouchDbs: Map<string, Map<string, { _id?: string; _rev?: string; title?: string }>>
	let encodeInitRaw: (d: unknown) => string
	beforeAll(() => {
		const { webcrypto } = require('crypto')
		if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
		const util = require('util')
		;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
		;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
		installDeviceKeyShim()
		globals = require('@/utils/globals')
		mod = require('./beamio')
		const { argon2id } = require('@noble/hashes/argon2.js')
		const testKdf = async (pw: Uint8Array, salt: Uint8Array) => Uint8Array.from(argon2id(pw, salt, { m: 8, t: 1, p: 1, dkLen: 32 }))
		require('@/services/passcode/mnemonicCipherV3').setMnemonicKdfForTest(testKdf)
		require('@/services/passcode/walletWrap').setPasscodeKdfForTest(testKdf)
		encodeInitRaw = require('./initRecordCodec').encodeInitRaw
		pouchDbs = require('pouchdb').__dbs
	})
	const A = (() => { const w = E0.Wallet.fromPhrase(PHRASE_A); return { keyID: String(w.address).toLowerCase(), privateKeyArmor: w.privateKey as string } })()
	const rec = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ ...A }] }
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
	const okRecord = (extra: Loose = {}) => ({ type: 'ack', ok: true, result: { code: 'ok', record: { ...clone(rec), rev: 1, ...extra } } })
	const ack = (result: Loose) => ({ type: 'ack', ok: true, result })
	const answers: Array<[string, unknown]> = [
		['N1 ok, W fields, rev 1', okRecord()],
		['N2 not_ready g1_uninitialized (retryable)', ack({ code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true })],
		['N3 not_ready storage_locked', ack({ code: 'not_ready', notReadyReason: 'storage_locked', retryable: false })],
		['N4 not_ready passcode_not_provided', ack({ code: 'not_ready', notReadyReason: 'passcode_not_provided' })],
		['N5 migrating', ack({ code: 'migrating' })],
		['N6 error needs_native_recovery', ack({ code: 'error', sub: 'needs_native_recovery' })],
		['N7 absent', ack({ code: 'absent' })],
		['N8 ok but record has no rev', { type: 'ack', ok: true, result: { code: 'ok', record: clone(rec) } }],
		['N9 ok, wallet fields redacted (G0), rev 1', { type: 'ack', ok: true, result: { code: 'ok', record: { isReady: true, profiles: [{ keyID: A.keyID }], rev: 1 } } }],
		['N11 error record_unreadable (record without integer rev, PGP header, adopt failure)', ack({ code: 'error', sub: 'record_unreadable' })],
		['N12 error account_mismatch', ack({ code: 'error', sub: 'account_mismatch' })],
		// the remaining codes of the shell's real read (iOS SDK 6808166 with shell e2771c77): every one is a native state the page cannot use
		['N13 error account_record_missing', ack({ code: 'error', sub: 'account_record_missing' })],
		['N14 error import_not_done', ack({ code: 'error', sub: 'import_not_done' })],
		['N15 error legacy_store_unreadable', ack({ code: 'error', sub: 'legacy_store_unreadable' })],
		['N16 too_large', ack({ code: 'too_large' })],
		['N17 not_ready unreadable (with cause)', ack({ code: 'not_ready', notReadyReason: 'unreadable', retryable: true, unreadableCause: 'decode' })],
		['N18 not_ready ambiguous_accounts', ack({ code: 'not_ready', notReadyReason: 'ambiguous_accounts', retryable: false })],
		['N19 envelope refused: bad_request', { type: 'ack', ok: false, error: 'bad_request' }],
		['N20 envelope refused: origin_refused', { type: 'ack', ok: false, error: 'origin_refused' }],
		['N10 not_ready_persistent', ack({ code: 'error', sub: 'not_ready_persistent', notReadyReason: 'unreadable', retryable: false })],
	]
	const pageStates: Array<[string, 'none' | 'valid']> = [['page absent', 'none'], ['page valid mnemonic', 'valid']]
	for (const [pname, pkind] of pageStates) {
		for (const [name, payload] of answers) {
			it(`${pname} / ${name}`, async () => {
				await mod.flushShellNativeSync()
				pouchDbs.clear()
				const g = globalThis as { __shellStore?: unknown; __shellMode?: boolean; __shellRev?: number; __nativeAnswer?: unknown }
				g.__shellStore = undefined
				g.__shellRev = 0
				g.__nativeAnswer = undefined
				g.__shellMode = false
				await mod.persistInitRecord(clone(rec)) // creates the PouchDB database (browser path)
				for (const docs of pouchDbs.values()) {
					if (pkind === 'none') docs.delete('init')
					else docs.set('init', { _id: 'init', _rev: '1-p', title: encodeInitRaw(rec) })
				}
				g.__shellMode = true
				g.__nativeAnswer = payload
				takePendingSync()
				await expect(mod.persistInitRecord(clone(rec))).resolves.toBeUndefined()
				await mod.flushShellNativeSync()
				const pageDoc = [...pouchDbs.values()][0]?.get('init')
				expect(pageDoc).toBeDefined()
				expect(String(pageDoc?.title ?? '')).not.toBe('')
				// ok and absent leave the native state known; any other answer is unknown (the save still completed) and a native sync is pending
				const known = name.startsWith('N1 ') || name.startsWith('N7 ') || name.startsWith('N8 ') || name.startsWith('N9 ')
				if (!known) expect(hasPendingSync()).toBe(true)
				g.__nativeAnswer = undefined
				g.__shellMode = false
			})
		}
	}
	it('a failure of the page write itself still fails the save (the notice is for this)', async () => {
		const g = globalThis as { __shellMode?: boolean; __nativeAnswer?: unknown; __pouchPutFail?: boolean }
		g.__shellMode = true
		g.__nativeAnswer = ack({ code: 'absent' })
		g.__pouchPutFail = true
		try {
			await expect(mod.persistInitRecord(clone(rec))).rejects.toBeDefined()
		} finally {
			g.__pouchPutFail = false
			g.__shellMode = false
			g.__nativeAnswer = undefined
		}
	})

	// --- the callers of the save: chat storage, history migration and key recovery -------------------------------
	const unknownAnswers = answers.filter(([n]) => !(n.startsWith('N1 ') || n.startsWith('N7 ') || n.startsWith('N8 ') || n.startsWith('N9 ')))
	const saveViaStoreSystemData = async (payload: unknown, shellMode: boolean): Promise<boolean> => {
		await mod.flushShellNativeSync()
		pouchDbs.clear()
		const g = globalThis as { __shellStore?: unknown; __shellMode?: boolean; __shellRev?: number; __nativeAnswer?: unknown }
		g.__shellStore = undefined
		g.__shellRev = 0
		g.__nativeAnswer = undefined
		g.__shellMode = false
		mod.setPageWritePermit('page_valid_mnemonic') // the save gate, as AppEntryGate opens it for a valid account
		globals.setCoNET_Data(clone(rec))
		await mod.persistInitRecord(clone(rec)) // creates the database
		g.__shellMode = shellMode
		g.__nativeAnswer = payload
		takePendingSync()
		clearPersistFailed()
		const stored = await mod.storeSystemDataAndWait()
		await mod.flushShellNativeSync()
		g.__nativeAnswer = undefined
		g.__shellMode = false
		return stored
	}
	for (const [name, payload] of unknownAnswers) {
		it(`chat storage (storeSystemDataAndWait) saves under a non-ok native answer: ${name}`, async () => {
			expect(await saveViaStoreSystemData(payload, true)).toBe(true)
			expect(isPersistFailed()).toBe(false)
			expect(hasPendingSync()).toBe(true)
		})
	}
	it('browser path: the save completes whatever the native answer stub holds (no native read at all)', async () => {
		for (const [, payload] of answers) {
			expect(await saveViaStoreSystemData(payload, false)).toBe(true)
			expect(isPersistFailed()).toBe(false)
		}
	})
	it('history migration: persistProfiles (the production save) succeeds and the core reaches the read-back check', async () => {
		for (const [, payload] of unknownAnswers) {
			let reachedReadBack = false
			let live: unknown[] = [{ keyID: A.keyID, chats: [] }]
			await saveViaStoreSystemData(payload, true) // arms the harness; the call below is the production persistProfiles
			const g = globalThis as { __shellMode?: boolean; __nativeAnswer?: unknown }
			g.__shellMode = true
			g.__nativeAnswer = payload
			const res = await runMigrationCore({
				workerState: async () => 'switched',
				workerSwitch: async () => true,
				workerPurge: async () => 0,
				liveProfiles: () => live,
				setLiveProfiles: (p) => { live = p },
				persistProfiles: () => mod.storeSystemDataAndWait(),
				readStoredProfiles: async () => { reachedReadBack = true; return null },
				markPurged: () => undefined,
			})
			g.__shellMode = false
			g.__nativeAnswer = undefined
			expect(reachedReadBack).toBe(true) // persist_failed would have stopped it before the read-back
			expect(res).toEqual({ ok: false, reason: 'readback_missing' })
		}
	}, 60000)
	it('key recovery: the persist step of the recovery path is the same save and not persist_failed', () => {
		const src = require('fs').readFileSync(require('path').join(__dirname, 'chat.ts'), 'utf8')
		expect(src).toContain("if (!(await storeSystemDataAndWait())) return { ok: false, reason: 'persist_failed' }")
	})

	it('persistent answers (migrating, legacy_store_unreadable, not_ready, too_large): every cold start saves at once, no retry needed', async () => {
		const persistent = answers.filter(([n]) => /^N(5|15|16|17|18|3) /.test(n))
		expect(persistent.length).toBe(6)
		for (const [, payload] of persistent) {
			for (let coldStart = 0; coldStart < 3; coldStart++) {
				expect(await saveViaStoreSystemData(payload, true)).toBe(true)
				expect(isPersistFailed()).toBe(false)
			}
		}
	}, 120000)

})
