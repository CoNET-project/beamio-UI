/**
 * @jest-environment node
 */
import { holdShellSessionFromPhrase, releaseShellSessionSignerHold } from './shellSessionSigner'
import { isPersistFailed } from './persistNoticeStatus'
/**
 * newUser keeps the reason of a failed registration call (R2271 side finding): no answer (network, CORS, TLS) is a CreateRemoteError('network'); a server answer
 * with a non-2xx status is a CreateRemoteError('http', status); a 2xx answer is true. Nothing is folded into false. The fetch is a stub: no request is made.
 * (header of the harness test this was built from follows)
 * M6, entry (b): the page IndexedDB record written for a ciphertext pre-read (persistPageIdbPasscodeRecord) is the PASSCODE record: the v3 envelope in
 * `mnemonicPhrase`, no plaintext phrase and no plaintext key anywhere in the stored bytes; the one cipher+passcode sync is sent by that write; after
 * a restart the record reads as locked (the unlock page), never as a valid plaintext record. Harness as persistRegression.test.ts (in-memory
 * PouchDB, in-memory device key, test KDF). Synthetic values only.
 * (harness header of persistRegression.test.ts follows)
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
			const g = globalThis as { __shellStore?: unknown; __shellRev?: number }
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

describe('newUser failure reasons', () => {
	let mod: Loose
	const PK = '0x' + '11'.repeat(32)
	const RECOVER = [{ hash: '0xaa', encrypto: 'AAAA' }]
	const realFetch = (globalThis as { fetch?: unknown }).fetch
	beforeAll(() => {
		const { webcrypto } = require('crypto')
		if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
		const util = require('util')
		;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
		;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
		installDeviceKeyShim()
		mod = require('./beamio')
	})
	afterEach(() => {
		;(globalThis as { fetch?: unknown }).fetch = realFetch
	})

	it('no answer (a network or CORS failure): CreateRemoteError network, not false', async () => {
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
			throw new TypeError('Failed to fetch')
		})
		await expect(mod.newUser('synthtag', RECOVER, PK)).rejects.toMatchObject({ name: 'CreateRemoteError', kind: 'network' })
	})
	it('a server answer with a non-2xx status: CreateRemoteError http, with the status', async () => {
		for (const status of [400, 409, 500, 503]) {
			;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status, json: async () => ({}) }))
			await expect(mod.newUser('synthtag', RECOVER, PK)).rejects.toMatchObject({ name: 'CreateRemoteError', kind: 'http', status })
		}
	})
	it('a 2xx answer: true', async () => {
		;(globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
		await expect(mod.newUser('synthtag', RECOVER, PK)).resolves.toBe(true)
	})
	it('a local sign failure is still a LocalCreateError (not a remote failure)', async () => {
		;(globalThis as { fetch?: unknown }).fetch = jest.fn()
		await expect(mod.newUser('synthtag', RECOVER, 'not-a-key')).rejects.toMatchObject({ name: 'LocalCreateError', step: 'sign_failed' })
		expect((globalThis as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled()
	})
})
