/**
 * @jest-environment node
 */
/**
 * 0.53.44 PART 1: refusal floor in persistInitRecord (shell branch). Runs through the production persistInitRecord and
 * storeSystemDataAndWait. Only the storage primitives are doubled (the native record store, the native account read, PouchDB, the
 * device key store and the KDF); the overwrite decision (validMnemonicEoa, the keyID comparison) is the production code.
 * FIXTURE values only: the public BIP-39 test phrases below and the addresses derived from them. No real account, device or credential.
 */
/* eslint-disable @typescript-eslint/no-var-requires */

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

// the in-memory PouchDB (the browser store's I/O boundary; unused in shell mode, kept so the production module loads)
jest.mock('pouchdb', () => {
	const dbs = new Map<string, Map<string, { _id: string; _rev: string; title?: string }>>()
	function PouchDB(name: string) {
		if (!dbs.has(name)) dbs.set(name, new Map())
		const docs = dbs.get(name)!
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
			remove: async (id: string) => {
				docs.delete(id)
			},
			close: async () => undefined,
		}
	}
	return { __esModule: true, default: PouchDB, __dbs: dbs }
})

jest.mock('./idbBlobCompat', () => ({ ...jest.requireActual('./idbBlobCompat'), idbBlobCompatReady: async () => 'ok' }))
jest.mock('./shellContext', () => ({ isShellContext: () => true }))
jest.mock('./walletEoaAddress', () => ({
	readWalletEoaAddress: async () => ({ kind: 'refused', code: 'error' }),
}))

// The native record store (the storage primitive). The write keeps the native W-class fields the way the production sync does.
// Counters are kept so the tests can prove that a refused save never reaches the write, and how many reads it made.
jest.mock('./shellRecordStore', () => {
	const actual = jest.requireActual('./shellRecordStore')
	const sanitizer = jest.requireActual('./shellRecordSanitizer')
	return {
		...actual,
		shellRecordWrite: async (data: unknown) => {
			const g = globalThis as { __shellStore?: Loose; __shellRev?: number; __shellWrites?: number }
			g.__shellWrites = (g.__shellWrites ?? 0) + 1
			const store = jest.requireActual('./shellRecordStore')
			store.buildShellRecordWriteCommand(0, data as Loose, 0)
			const sent = sanitizer.stripWalletFields(sanitizer.sanitizeForBridge(data)) as Loose
			const prev = g.__shellStore
			if (prev) {
				if (prev.mnemonicPhrase !== undefined) sent.mnemonicPhrase = prev.mnemonicPhrase
				for (const p of (sent.profiles ?? []) as Loose[]) {
					const q = ((prev.profiles ?? []) as Loose[]).find((x) => x.keyID === p.keyID)
					if (q && q.privateKeyArmor !== undefined) p.privateKeyArmor = q.privateKeyArmor
				}
			}
			;(globalThis as { __lastWrite?: unknown }).__lastWrite = JSON.parse(JSON.stringify(data))
			g.__shellStore = JSON.parse(JSON.stringify(sent))
			g.__shellRev = (g.__shellRev ?? 0) + 1
			return { status: 'ok', rev: g.__shellRev }
		},
		shellRecordRead: async () => {
			const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __shellReads?: number }
			g.__shellReads = (g.__shellReads ?? 0) + 1
			if (g.__shellStore === undefined) return { status: 'absent' }
			return { status: 'ok', record: JSON.parse(JSON.stringify(g.__shellStore)), rev: g.__shellRev ?? 0, walletFieldsRedacted: false }
		},
		// the native fresh-write isolation is a native command; these cases do not exercise it (the key-only isolation is covered elsewhere)
		prepareShellFreshWrite: async () => ({ isolated: false }),
	}
})

type Loose = Record<string, any>

// FIXTURE: the in-memory device key store (test double of the IndexedDB device store)
const deviceStore = new Map<string, unknown>()
function installDeviceKeyShim(): void {
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
}

if (!(globalThis as { window?: unknown }).window) {
	;(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' }, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }
}

const E0 = require('ethers')
// FIXTURE: public BIP-39 test phrases (not a wallet)
const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

describe('persistInitRecord refusal floor, shell branch (0.53.44 PART 1, FIXTURE values)', () => {
	let mod: Loose
	let globals: Loose
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
	const acct = (phrase: string) => {
		const w = E0.Wallet.fromPhrase(phrase)
		return { keyID: String(w.address).toLowerCase(), privateKeyArmor: w.privateKey as string }
	}
	const A = acct(PHRASE_A)
	const B = acct(PHRASE_B)
	const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __shellWrites?: number; __shellReads?: number; __lastWrite?: Loose }
	const storeBytes = () => JSON.stringify(g.__shellStore ?? null)

	beforeAll(() => {
		const { webcrypto } = require('crypto')
		if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
			Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
		}
		const util = require('util')
		;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
		;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
		installDeviceKeyShim()
		globals = require('@/utils/globals')
		mod = require('./beamio')
	})

	beforeEach(() => {
		g.__shellStore = undefined
		g.__shellRev = 0
		g.__shellWrites = 0
		g.__shellReads = 0
	})

	/** FIXTURE record with a valid mnemonic for the account (the in-memory copy the page writes). */
	const fullRecord = (phrase: string, a: { keyID: string; privateKeyArmor: string }) => ({
		mnemonicPhrase: phrase,
		isReady: true,
		profiles: [{ keyID: a.keyID, privateKeyArmor: a.privateKeyArmor, userName: 'fixture' }],
	})
	/** FIXTURE key-only copy: the EOA key and no mnemonic (not an account). */
	const keyOnly = (a: { keyID: string; privateKeyArmor: string }) => ({ isReady: true, profiles: [{ keyID: a.keyID, privateKeyArmor: a.privateKeyArmor }] })

	// (a) native restore: the page holds a key-only copy; the restored account (its mnemonic from the native side) is written
	it('(a) native restore still writes: key-only copy existing, restored account with its mnemonic is written', async () => {
		g.__shellStore = clone(keyOnly(A))
		const restored = fullRecord(PHRASE_A, A)
		await expect(mod.persistInitRecord(clone(restored))).resolves.toBeUndefined()
		expect(g.__shellWrites).toBe(1)
		expect(JSON.stringify(g.__shellStore)).toContain(A.keyID)
	})

	// (b) brand-new account: no existing record, the new account is written
	it('(b) brand-new account write with no existing record still writes', async () => {
		g.__shellStore = undefined
		await expect(mod.persistInitRecord(clone(fullRecord(PHRASE_B, B)))).resolves.toBeUndefined()
		expect(g.__shellWrites).toBe(1)
	})

	// (c) same-account update: same keyID, the mnemonic kept
	it('(c) same-account update (same keyID, mnemonic kept) still writes', async () => {
		g.__shellStore = clone(fullRecord(PHRASE_A, A))
		const edited = fullRecord(PHRASE_A, A)
		edited.profiles[0].userName = 'fixture-edited'
		await expect(mod.persistInitRecord(clone(edited))).resolves.toBeUndefined()
		expect(g.__shellWrites).toBe(1)
	})

	// refusal: an existing valid account is not replaced by another account
	it('refuses another account over a valid page record (keyID differs) and writes nothing', async () => {
		g.__shellStore = clone(fullRecord(PHRASE_A, A))
		const before = storeBytes()
		await expect(mod.persistInitRecord(clone(fullRecord(PHRASE_B, B)))).rejects.toThrow('page_record_overwrite_refused')
		expect(g.__shellWrites).toBe(0)
		expect(storeBytes()).toBe(before)
	})

	// 0.53.44: a legitimate save of the same account whose copy carries no mnemonic (the publicWalletSeed copy of a valid page entry)
	// is not refused: the complete existing record is read first and the new copy is merged in. The mnemonic is kept byte for byte.
	it('same account without a mnemonic in the new copy: not refused; the existing mnemonic and private key armor are kept byte for byte', async () => {
		g.__shellStore = clone(fullRecord(PHRASE_A, A))
		const existingPhrase = PHRASE_A
		const existingArmor = (g.__shellStore as Loose).profiles[0].privateKeyArmor as string
		const noMnemonic = { isReady: true, profiles: [{ keyID: A.keyID, userName: 'fixture-edited' }] }
		await expect(mod.persistInitRecord(clone(noMnemonic))).resolves.toBeUndefined()
		expect(g.__shellWrites).toBe(1)
		// the written copy and the stored record keep the account's mnemonic: compared on the decrypted plain record (byte for byte)
		const written = g.__lastWrite as Loose
		expect(written.mnemonicPhrase).toBeDefined()
		const back = (await mod.readStoredRecordForVerify()) as Loose
		expect(Buffer.from(String(back.mnemonicPhrase), 'utf8').equals(Buffer.from(PHRASE_A, 'utf8'))).toBe(true)
		expect(Buffer.from(String(back.mnemonicPhrase), 'utf8').equals(Buffer.from(existingPhrase, 'utf8'))).toBe(true)
		expect((g.__shellStore as Loose).profiles[0].privateKeyArmor).toBe(existingArmor)
		expect((g.__shellStore as Loose).profiles[0].userName).toBe('fixture-edited')
	})

	// refusal: a record without a mnemonic for ANOTHER keyID does not replace a valid account
	it('refuses a record without a mnemonic for another keyID over a valid page record and writes nothing', async () => {
		g.__shellStore = clone(fullRecord(PHRASE_A, A))
		const before = storeBytes()
		const otherNoMnemonic = { isReady: true, profiles: [{ keyID: B.keyID, privateKeyArmor: B.privateKeyArmor }] }
		await expect(mod.persistInitRecord(clone(otherNoMnemonic))).rejects.toThrow('page_record_overwrite_refused')
		expect(g.__shellWrites).toBe(0)
		expect(storeBytes()).toBe(before)
	})

	// fail-closed: the existing phrase is present but cannot be derived
	it('fail-closed: an existing phrase that cannot be derived is refused (writes nothing)', async () => {
		g.__shellStore = { mnemonicPhrase: 'not a valid bip39 phrase for this fixture', isReady: true, profiles: [{ keyID: A.keyID, privateKeyArmor: A.privateKeyArmor }] }
		const before = storeBytes()
		await expect(mod.persistInitRecord(clone(fullRecord(PHRASE_A, A)))).rejects.toThrow('page_record_overwrite_refused')
		expect(g.__shellWrites).toBe(0)
		expect(storeBytes()).toBe(before)
	})

	// bounded retry: a refused save is one attempt per call, no loop, no write, no retry notice
	it('storeSystemDataAndWait on a refused overwrite makes one attempt per call, writes nothing, and resolves false (bounded)', async () => {
		const { isPersistFailed } = require('./persistNoticeStatus')
		g.__shellStore = clone(fullRecord(PHRASE_A, A))
		const before = storeBytes()
		globals.setCoNET_Data(clone(fullRecord(PHRASE_B, B)))
		const readsBefore = g.__shellReads ?? 0
		const refusedBefore = mod.pageWriteGateStatus().overwriteRefused
		// 0.53.44: the gate is closed by default; open it so the save reaches the guard (the gate itself is covered in App.onboardGapRepro)
		mod.setPageWritePermit('page_valid_mnemonic')
		const results: boolean[] = []
		for (let i = 0; i < 3; i++) results.push(await mod.storeSystemDataAndWait())
		expect(results).toEqual([false, false, false])
		// 0.53.44 (item 4): each refused overwrite is counted (diagnostic code page_record_overwrite_refused; no UI)
		expect(mod.pageWriteGateStatus().overwriteRefused - refusedBefore).toBe(3)
		// one guard read per save (3 total), no write, the stored bytes are unchanged
		expect((g.__shellReads ?? 0) - readsBefore).toBe(3)
		expect(g.__shellWrites).toBe(0)
		expect(storeBytes()).toBe(before)
		expect(isPersistFailed()).toBe(false)
	})
})
