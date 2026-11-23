/**
 * @jest-environment node
 */
/**
 * Unit (b), the decision (node environment, synthetic accounts only; the harness is the persistRegression one):
 * - the page IndexedDB read has three states (valid, absent, unknown); a corrupt record is unknown, never absent;
 * - the shell start reads the page IndexedDB first and on its own: a native not_ready, lock or record does not block a valid local mnemonic
 *   (zero native record reads), and an absent page store does not read the native record at start (the pre-read decides, in the gate);
 * - the write-back of a pre-read mnemonic is verified by an independent read of the mnemonic from IndexedDB whose derived address
 *   equals the account (not a shell record read, an address or a generic record read-back);
 * - the stored wallet record is wrapped (no plaintext mnemonic in the stored document).
 */
import { holdShellSessionFromPhrase, releaseShellSessionSignerHold } from './shellSessionSigner'
import { isPersistFailed } from './persistNoticeStatus'
/**
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
// argon2idAsync must not run in these tests (the PBKDF2 stand-in is removed). The bridge module cannot load in jest (import.meta),
// so it stays mocked, but a call fails closed. A test that needs the v3 KDF injects it with setMnemonicKdfForTest.
jest.mock('@/services/argon2WorkerBridge', () => ({
	argon2idAsync: () => {
		throw new Error('argon2idAsync must not run in this test: inject the v3 KDF with setMnemonicKdfForTest')
	},
}))

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
				// test double of a store that does not keep the bytes it was given (the durable put must catch it)
				docs.set(doc._id, { _id: doc._id, _rev: rev, title: (globalThis as { __corruptPut?: boolean }).__corruptPut ? 'corrupted-bytes' : doc.title })
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

// the first pwaWalletSync with the cipher (set passcode): a recording double whose reply is ok (test only; no product code changed)
jest.mock('./pwaWalletSyncTransport', () => ({
	...jest.requireActual('./pwaWalletSyncTransport'),
	sendPwaWalletSyncCipher: (command: string, seq: number, cipher: unknown, passcode?: string) => {
		const g = globalThis as { __cipherSyncCalls?: unknown[] }
		;(g.__cipherSyncCalls ??= []).push({ command, seq, cipher, passcode })
		return Promise.resolve({ code: 'ok' })
	},
}))

// the production cooldown store is IndexedDB; this file has none, so the cooldown record is an in-memory atomic store (test double, reset per case)
jest.mock('./passcode/passcodeWrapStore', () => {
	const actual = jest.requireActual('./passcode/passcodeWrapStore')
	return {
		...actual,
		idbKeyValueDb: () => ((globalThis as { __cooldownDb?: unknown }).__cooldownDb ??= actual.memoryAtomicKeyValueDb()),
	}
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
			const g = globalThis as { __shellStore?: Loose; __shellRev?: number; __holdNativeWrite?: boolean }
			// test switch: a native write that never answers (the background sync is still in flight)
			if (g.__holdNativeWrite) return new Promise<void>((resolve) => { (globalThis as { __releaseHold?: () => void }).__releaseHold = resolve })
			if ((g as { __failNativeWrite?: boolean }).__failNativeWrite) throw new Error('native_write_failed')
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
			const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __shellReads?: number }
			g.__shellReads = (g.__shellReads ?? 0) + 1
			if (g.__shellStore === '__unknown__') return { status: 'error', reason: 'not_ready' } // a native read that did not answer
			if (g.__shellStore === undefined) return { status: 'absent' }
			return { status: 'ok', record: JSON.parse(JSON.stringify(g.__shellStore)), rev: g.__shellRev ?? 0, walletFieldsRedacted: false }
		},
		prepareShellFreshWrite: async () => ({ isolated: false }),
	}
})

type Loose = Record<string, any>

if (!(globalThis as { window?: unknown }).window) {
	// node env: a minimal window (location only), enough for the browser-side URL constants and the iOS bridge probe
	;(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' }, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true }
}
const E0 = require('ethers')
const PHRASE_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow'


const eoaOf = (phrase: string) => String(E0.Wallet.fromPhrase(phrase).address).toLowerCase()
const EOA_A = eoaOf(PHRASE_A)
const KEY_A = String(E0.Wallet.fromPhrase(PHRASE_A).privateKey)
const EOA_B = eoaOf(PHRASE_B)

describe('unit (b): page IndexedDB states, write-back and native-first ordering (synthetic)', () => {
	let mod: Loose
	let pouchDbs: Map<string, Map<string, { _id?: string; _rev?: string; title?: string }>>
	const g = globalThis as Loose
	const idbDoc = (): { title?: string } | undefined => [...pouchDbs.values()][0]?.get('init')
	const seedIdb = (title: string | undefined) => {
		const db = [...pouchDbs.values()][0] ?? new Map()
		if (!pouchDbs.size) pouchDbs.set('conet', db)
		if (title === undefined) db.delete('init')
		else db.set('init', { _id: 'init', _rev: '1-seed', title })
	}
	beforeAll(() => {
		const { webcrypto } = require('crypto')
		if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
			Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
		}
		const util = require('util')
		;(globalThis as { TextEncoder?: unknown }).TextEncoder ??= util.TextEncoder
		;(globalThis as { TextDecoder?: unknown }).TextDecoder ??= util.TextDecoder
		mod = require('./beamio')
		pouchDbs = require('pouchdb').__dbs
	})
	beforeEach(() => {
		pouchDbs.clear()
		g.__shellMode = true
		g.__shellStore = undefined
		g.__shellReads = 0
		g.__nativeEoa = undefined
	})
	afterEach(() => {
		g.__shellMode = false
	})

	const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64')
	const plainRecord = (phrase: string, eoa: string) => ({ mnemonicPhrase: phrase, isReady: true, profiles: [{ keyID: eoa, privateKeyArmor: `0x${'11'.repeat(32)}` }] })

	it('the page IndexedDB read clears its own timeout timer when it settles (no open handle left; 2026-11-22 startupIdbFirst)', async () => {
		const spy = jest.spyOn(globalThis, 'clearTimeout')
		try {
			await mod.readPageIdbInit()
			expect(spy).toHaveBeenCalled()
		} finally {
			spy.mockRestore()
		}
	})

	it('three states: absent (no document) and corrupt (not a record) is unknown, never absent', async () => {
		seedIdb(undefined)
		expect((await mod.readPageIdbInit()).status).toBe('absent')
		seedIdb('%%% not a record %%%')
		const corrupt = await mod.readPageIdbInit()
		expect(corrupt).toEqual({ status: 'unknown', reason: 'corrupt_record' })
	})

	it('a plaintext record with a valid mnemonic is valid; a record with an undecodable mnemonic is unknown', async () => {
		seedIdb(b64(plainRecord(PHRASE_A, EOA_A)))
		const valid = await mod.readPageIdbInit()
		expect(valid.status).toBe('valid')
		expect(valid.status === 'valid' && valid.eoa).toBe(EOA_A)
		seedIdb(b64({ mnemonicPhrase: 'not a real phrase at all', profiles: [{ keyID: EOA_A, privateKeyArmor: `0x${'11'.repeat(32)}` }] }))
		expect(await mod.readPageIdbInit()).toEqual({ status: 'unknown', reason: 'corrupt_record' })
	})

	it('a non-empty record with signing material but no mnemonic is unknown (keep data), never absent', async () => {
		seedIdb(b64({ profiles: [{ keyID: EOA_A, privateKeyArmor: `0x${'22'.repeat(32)}` }], beamio: { accountName: 'synthtag' } }))
		const state = await mod.readPageIdbInit()
		expect(state.status).toBe('unknown')
	})

	// Split (a): the original case expected the passcode wrap while no passcode is on. The spec () writes the
	// mnemonic as plaintext with no passcode, so the two states are two cases. Each case resets its own state; nothing is shared.
	it('write-back without a passcode: the page IndexedDB holds the mnemonic as plaintext (spec e287630a); the read-back gives the same phrase and account', async () => {
		seedIdb(undefined)
		const verdict = await mod.persistPageIdbMnemonic({ mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A }] }, PHRASE_A, EOA_A)
		expect(verdict).toBe('verified')
		const stored = idbDoc()?.title ?? ''
		expect(stored).not.toBe('')
		expect(JSON.parse(Buffer.from(stored, 'base64').toString()).mnemonicPhrase).toBe(PHRASE_A)
		// the shell record was not read or written by the write-back
		expect(g.__shellReads).toBe(0)
		expect(g.__shellStore).toBeUndefined()
		const back = await mod.readPageIdbInit()
		expect(back.status === 'valid' && back.eoa).toBe(EOA_A)
		expect(back.status === 'valid' && back.phrase).toBe(PHRASE_A)
	}, 30000)

	it('write-back with a passcode on: a v3 wrap is written through the normal set flow, the stored bytes are unchanged by the read-back, it unlocks with the passcode, and the address is the account', async () => {
		const { setMnemonicKdfForTest } = require('./passcode/mnemonicCipherV3')
		const { setPasscodeKdfForTest, isWrapRecord } = require('./passcode/walletWrap')
		const { resetWalletSession } = require('./passcode/walletVault')
		const { argon2id } = require('@noble/hashes/argon2.js')
		const globals = require('@/utils/globals')
		const P1 = '482159'
		// 2026-11-22 (1): reduced Argon2id parameters for speed (the same algorithm); the production parameters are covered by walletVaultF3Legacy and the MCF3 vectors
		const kdf = async (pw: Uint8Array, salt: Uint8Array, o: { m: number; t: number; p: number; dkLen: number }) =>
			Uint8Array.from(argon2id(pw, salt, { m: 1024, t: 1, p: 1, dkLen: o.dkLen }))
		g.__shellMode = false
		g.__cipherSyncCalls = []
		g.__cooldownDb = undefined
		setMnemonicKdfForTest(kdf)
		setPasscodeKdfForTest(kdf)
		try {
			seedIdb(undefined)
			const plain = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A }] }
			globals.setCoNET_Data(JSON.parse(JSON.stringify(plain)))
			const set = await mod.setWalletVaultPasscode(P1)
			expect(set).toEqual({ ok: true })
			expect((g.__cipherSyncCalls as unknown[]).length).toBe(1)
			const verdict = await mod.persistPageIdbMnemonic(plain, PHRASE_A, EOA_A)
			expect(verdict).toBe('verified')
			const stored = idbDoc()?.title ?? ''
			const rec = JSON.parse(Buffer.from(stored, 'base64').toString())
			// the mnemonic slot is a v3 wrap (passcode mode); the phrase is not in the stored bytes
			expect(isWrapRecord(rec.mnemonicPhrase)).toBe(true)
			expect(rec.mnemonicPhrase.v).toBe(3)
			expect(Buffer.from(stored, 'base64').toString().includes(PHRASE_A)).toBe(false)
			// byte-identical after the read-back: the read does not change the stored document
			const back = await mod.readPageIdbInit()
			expect(back.status === 'valid' && back.eoa).toBe(EOA_A)
			expect(idbDoc()?.title).toBe(stored)
			// unlock with the passcode after the in-memory session is dropped; the mnemonic and the address are the account's
			resetWalletSession()
			expect((await mod.unlockWalletVaultWithPasscode(P1)).ok).toBe(true)
			const after = await mod.readPageIdbInit()
			expect(after.status === 'valid' && after.phrase).toBe(PHRASE_A)
			expect(after.status === 'valid' && after.eoa).toBe(EOA_A)
		} finally {
			resetWalletSession()
			setMnemonicKdfForTest(null)
			setPasscodeKdfForTest(null)
			g.__cipherSyncCalls = []
			g.__shellMode = true
		}
	}, 60000)

	it('item 1: a shell profile save writes the page IndexedDB first; a restart reads the new value from IndexedDB while the native copy is stale', async () => {
		seedIdb(b64({ mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, userName: 'old-name' }] }))
		g.__shellStore = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, userName: 'native-stale' }] }
		g.__holdNativeWrite = true
		try {
			await mod.persistInitRecord({ mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, userName: 'new-name' }] })
			// the page IndexedDB holds the saved value, verified by the read-back of the mnemonic
			const idb = await mod.readPageIdbInit()
			expect(idb.status === 'valid' && idb.data.profiles[0].userName).toBe('new-name')
			// the native copy is still the stale one (its sync is in flight): the restart cannot be showing it
			expect((g.__shellStore as Loose).profiles[0].userName).toBe('native-stale')
			g.__shellReads = 0
			const restart = await mod.checkStorageWithStatus()
			expect(restart.status).toBe('loaded')
			expect((restart as Loose).data.profiles[0].userName).toBe('new-name')
			expect(g.__shellReads).toBe(0)
		} finally {
			g.__holdNativeWrite = false
			;(globalThis as { __releaseHold?: () => void }).__releaseHold?.()
			await mod.flushShellNativeSync()
		}
	})

	it('item 1: a native sync failure after a verified page save is a pending sync; the save still resolves', async () => {
		seedIdb(b64(plainRecord(PHRASE_A, EOA_A)))
		g.__shellStore = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, userName: 'old-x' }] }
		g.__failNativeWrite = true
		try {
			await expect(mod.persistInitRecord({ mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A, privateKeyArmor: KEY_A, userName: 'x-name' }] })).resolves.toBeUndefined()
			await mod.flushShellNativeSync()
		} finally {
			g.__failNativeWrite = false
		}
		const idb = await mod.readPageIdbInit()
		expect(idb.status === 'valid' && idb.data.profiles[0].userName).toBe('x-name')
	})

	it('write-back is not verified when the stored bytes differ from what was written (no home on an unconfirmed write)', async () => {
		seedIdb(undefined)
		g.__corruptPut = true
		try {
			const verdict = await mod.persistPageIdbMnemonic({ mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: EOA_A }] }, PHRASE_A, EOA_A)
			expect(verdict).not.toBe('verified')
		} finally {
			g.__corruptPut = false
		}
	})

	it('write-back refuses to replace a valid mnemonic of another account, and an unknown page store is not overwritten', async () => {
		seedIdb(b64(plainRecord(PHRASE_B, EOA_B)))
		expect(await mod.persistPageIdbMnemonic({ mnemonicPhrase: PHRASE_A, profiles: [{ keyID: EOA_A }] }, PHRASE_A, EOA_A)).toBe('refused_other_account')
		expect(JSON.parse(Buffer.from(idbDoc()!.title!, 'base64').toString()).mnemonicPhrase).toBe(PHRASE_B)
		seedIdb('%%% corrupt %%%')
		expect(await mod.persistPageIdbMnemonic({ mnemonicPhrase: PHRASE_A, profiles: [{ keyID: EOA_A }] }, PHRASE_A, EOA_A)).toBe('unknown_before')
		expect(idbDoc()!.title).toBe('%%% corrupt %%%')
	})

	it('start read: a valid page mnemonic enters with zero native record reads, even when the native store answers not_ready', async () => {
		seedIdb(b64(plainRecord(PHRASE_A, EOA_A)))
		g.__shellStore = '__unknown__'
		const read = await mod.checkStorageWithStatus()
		expect(read.status).toBe('loaded')
		expect((read as Loose).data.mnemonicPhrase).toBe(PHRASE_A)
		expect(g.__shellReads).toBe(0)
	})

	it('start read: an absent page store does not read the native record at start (the pre-read decides)', async () => {
		seedIdb(undefined)
		g.__shellStore = { mnemonicPhrase: PHRASE_B, profiles: [{ keyID: EOA_B }] }
		const read = await mod.checkStorageWithStatus()
		expect(read.status).toBe('empty')
		expect(g.__shellReads).toBe(0)
	})

	it('start read: an unknown page store is held (unavailable), with zero native record reads', async () => {
		seedIdb('%%% corrupt %%%')
		g.__shellStore = { mnemonicPhrase: PHRASE_B, profiles: [{ keyID: EOA_B }] }
		const read = await mod.checkStorageWithStatus()
		expect(read.status).toBe('unavailable')
		expect(g.__shellReads).toBe(0)
	})
})
