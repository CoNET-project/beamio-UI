/**
 * @jest-environment node
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

describe('persistInitRecord through the production path, shell and browser (synthetic)', () => {
	let mod: Loose
	let globals: Loose
	let pouchDbs: Map<string, Map<string, { _id?: string; _rev?: string; title?: string }>>
	let encodeInitRaw: (d: unknown) => string
	let parseInitRaw: (b64: string) => Loose | null

	afterAll(() => {
		require('@/services/passcode/mnemonicCipherV3').setMnemonicKdfForTest(null)
		require('@/services/passcode/walletWrap').setPasscodeKdfForTest(null)
	})

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
		// v3 KDF 注入（f3 入口）：真实 Argon2id（@noble/hashes），测试用降低成本 m=8 KiB、t=1；真实参数由 walletVaultF3Legacy.test.ts 覆盖。
		const { argon2id } = require('@noble/hashes/argon2.js')
		const testKdf = async (pw: Uint8Array, salt: Uint8Array) => Uint8Array.from(argon2id(pw, salt, { m: 8, t: 1, p: 1, dkLen: 32 }))
		require('@/services/passcode/mnemonicCipherV3').setMnemonicKdfForTest(testKdf)
		require('@/services/passcode/walletWrap').setPasscodeKdfForTest(testKdf)
		encodeInitRaw = require('./initRecordCodec').encodeInitRaw
		parseInitRaw = require('./initRecordCodec').parseInitRaw
		pouchDbs = require('pouchdb').__dbs
	})

	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
	const acct = (phrase: string) => {
		const w = E0.Wallet.fromPhrase(phrase)
		return { keyID: String(w.address).toLowerCase(), privateKeyArmor: w.privateKey as string }
	}
	const recordOf = (phrase: string, accounts: Array<{ keyID: string; privateKeyArmor: string }>) => ({
		mnemonicPhrase: phrase,
		isReady: true,
		profiles: accounts.map((a) => ({ ...a })),
	})
	/** JSON-normalised decrypted record; *Wrap storage metadata and the empty pgpKey shape are left out (see the pgpKey note). */
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm)
		if (v && typeof v === 'object') {
			const out: Loose = {}
			// key-sorted: criterion (a) compares canonical JSON, so the key order the native side returns does not count
			for (const k of Object.keys(v as Loose).sort()) {
				const val = (v as Loose)[k]
				if (k.endsWith('Wrap')) continue
				if (k === 'pgpKey' && val && typeof val === 'object' && Object.keys(val as object).length === 0) continue
				out[k] = norm(val)
			}
			return out
		}
		return v
	}
	/** Criterion (a): the decrypted read through the production reader. */
	const readBack = async () => norm(await mod.readStoredRecordForVerify())
	/** Criterion (b): the bytes as stored. Browser: the PouchDB 'init' document, decoded; shell: the native copy as written. */
	const rawBrowser = (): Loose | null => {
		const db = [...pouchDbs.values()][0]
		const doc = db?.get('init')
		return doc?.title ? parseInitRaw(doc.title) : null
	}
	const rawShell = (): Loose | null => clone((globalThis as { __shellStore?: Loose }).__shellStore ?? null)
	const raw = (shell: boolean) => (shell ? rawShell() : rawBrowser())

	/** Seeds the stored state. 'wrapped': through the production write. 'plain': a legacy plaintext copy on disk / native. */
	const seed = async (shell: boolean, kind: 'wrapped' | 'plain', rec: Loose) => {
		// unit (b): a shell save's native sync runs in the background; a case waits for it before the next case starts
		await mod.flushShellNativeSync()
		pouchDbs.clear()
		const g = globalThis as { __shellStore?: unknown; __shellMode?: boolean; __shellRev?: number }
		g.__shellStore = undefined
		g.__shellRev = 0
		g.__shellMode = shell
		globals.setCoNET_Data(clone(rec))
		if (shell) {
			// the native store holds the W-class fields in plaintext (scheme A: the EOA key is what a shell record holds)
			g.__shellStore = clone(rec)
			return
		}
		await mod.persistInitRecord(clone(rec)) // creates the database
		if (kind === 'plain') {
			for (const docs of pouchDbs.values()) docs.set('init', { _id: 'init', _rev: '1-p', title: encodeInitRaw(rec) })
		}
	}

	const A = acct(PHRASE_A)
	const B = acct(PHRASE_B)
	const P1 = '482159'
	const P2 = '703162'
	const browserFixtures = [
		{ name: '(a) wrapped key', kind: 'wrapped' as const, rec: recordOf(PHRASE_A, [A]) },
		{ name: '(b) legacy plaintext key', kind: 'plain' as const, rec: recordOf(PHRASE_A, [A]) },
		{ name: '(c) two accounts (wrapped)', kind: 'wrapped' as const, rec: recordOf(PHRASE_A, [A, B]) },
	]
	const shellFixtures = [
		{ name: '(d) native plaintext key', kind: 'plain' as const, rec: recordOf(PHRASE_A, [A]) },
		{ name: '(e) native two accounts', kind: 'plain' as const, rec: recordOf(PHRASE_A, [A, B]) },
	]
	const paths: Array<{ name: string; run: () => Promise<void> }> = [
		{ name: 'pre-read valid path (releaseShellSessionSignerHold)', run: async () => releaseShellSessionSignerHold() },
		{ name: 'prepareShellEntry mismatch branch (releaseShellSessionSignerHold)', run: async () => releaseShellSessionSignerHold() },
		{ name: 'onVaultLocked (releaseShellSessionSignerHold)', run: async () => releaseShellSessionSignerHold() },
		{
			name: 'signOutLocal (signOutLocalWallet)',
			run: async () => {
				const { signOutLocalWallet } = require('./signOutLocal')
				await signOutLocalWallet()
			},
		},
	]

	// criterion (a), signer paths: after the path, the production write, then the decrypted read equals the read before
	for (const mode of ['browser', 'shell'] as const) {
		const shell = mode === 'shell'
		for (const fx of shell ? shellFixtures : browserFixtures) {
			for (const path of paths) {
				it(`${mode}: ${fx.name} / ${path.name}: decrypted read-back unchanged (criterion a)`, async () => {
					await seed(shell, fx.kind, fx.rec)
					const before = await readBack()
					expect(before).not.toBeNull()
					globals.setCoNET_Data(clone(fx.rec))
					holdShellSessionFromPhrase(PHRASE_A, A.keyID)
					await path.run()
					await mod.persistInitRecord(clone(globals.CoNET_Data))
					expect(JSON.stringify(await readBack())).toBe(JSON.stringify(before))
				})
			}
		}
	}

	// criterion (a), same-account operations, each through the production writer and persistInitRecord.
	// Browser only: on the shell, setting a passcode returns 'error' (verifyWrapped reads the native copy back and finds the
	// plaintext the page never replaced, since the page write strips W-class fields; walletVault.ts verifyWrapped). Reported
	// as a production question, not asserted green here. The shell migration is run below.
	for (const mode of ['browser', 'shell'] as const) {
		const shell = mode === 'shell'
		const base = shell ? shellFixtures[0] : browserFixtures[1]
		if (shell) {
			continue
		}

		it(`${mode}: set passcode, then persistInitRecord: decrypted read-back unchanged (criterion a)`, async () => {
			await seed(shell, base.kind, base.rec)
			const before = await readBack()
			globals.setCoNET_Data(clone(base.rec))
			const res = await mod.setWalletVaultPasscode(P1)
			expect(res.ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			expect(JSON.stringify(await readBack())).toBe(JSON.stringify(before))
		})

		it(`${mode}: change passcode, then persistInitRecord: decrypted read-back unchanged (criterion a)`, async () => {
			await seed(shell, base.kind, base.rec)
			globals.setCoNET_Data(clone(base.rec))
			expect((await mod.setWalletVaultPasscode(P1)).ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			const before = await readBack()
			const res = await mod.changeWalletVaultPasscode(P1, P2)
			expect(res.ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			expect(JSON.stringify(await readBack())).toBe(JSON.stringify(before))
		})

		it(`${mode}: disable passcode, then persistInitRecord: decrypted read-back unchanged (criterion a)`, async () => {
			await seed(shell, base.kind, base.rec)
			globals.setCoNET_Data(clone(base.rec))
			expect((await mod.setWalletVaultPasscode(P1)).ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			const before = await readBack()
			const res = await mod.disableWalletVaultPasscode(P1)
			expect(res.ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			expect(JSON.stringify(await readBack())).toBe(JSON.stringify(before))
		})

		it(`${mode}: the product set path sends the v3 cipher with the passcode in the first pwaWalletSync`, async () => {
			await seed(shell, base.kind, base.rec)
			globals.setCoNET_Data(clone(base.rec))
			;(globalThis as { __cipherSyncCalls?: unknown[] }).__cipherSyncCalls = []
			expect((await mod.setWalletVaultPasscode(P1)).ok).toBe(true)
			const calls = (globalThis as { __cipherSyncCalls?: Array<{ command: string; cipher: Loose; passcode?: string }> }).__cipherSyncCalls ?? []
			expect(calls).toHaveLength(1)
			expect(calls[0].command).toBe('pwaWalletSync')
			expect(calls[0].cipher).toMatchObject({ v: 3, mode: 'passcode', alg: 'AES-256-GCM' })
			expect(calls[0].passcode).toBe(P1)
		})

		it(`${mode}: an unconfirmed first sync is handed to the registered background mechanism with the cipher (no passcode kept)`, async () => {
			await seed(shell, base.kind, base.rec)
			globals.setCoNET_Data(clone(base.rec))
			const handoff = require('./passcode/syncPendingHandoff')
			const calls: Array<[Record<string, unknown>, string]> = []
			handoff.setSyncPendingHandler((c: Record<string, unknown>, e: string) => calls.push([c, e]))
			;(globalThis as { __cipherReply?: string }).__cipherReply = 'no_answer'
			try {
				const res = await mod.setWalletVaultPasscode(P1)
				expect(res).toMatchObject({ ok: false, reason: 'sync_pending' })
				expect(calls).toHaveLength(1)
				expect(calls[0][0]).toMatchObject({ v: 3, mode: 'passcode' })
				expect(calls[0][1]).toBe(base.rec.profiles[0].keyID.toLowerCase())
			} finally {
				;(globalThis as { __cipherReply?: string }).__cipherReply = undefined
				handoff.setSyncPendingHandler(null)
			}
		})

		it(`${mode}: the product disable path calls shellMnemonicSync.sync once with the phrase and the account`, async () => {
			await seed(shell, base.kind, base.rec)
			globals.setCoNET_Data(clone(base.rec))
			expect((await mod.setWalletVaultPasscode(P1)).ok).toBe(true)
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			const { shellMnemonicSync } = require('./shellMnemonicSync')
			shellMnemonicSync.sync.mockClear()
			expect((await mod.disableWalletVaultPasscode(P1)).ok).toBe(true)
			expect(shellMnemonicSync.sync).toHaveBeenCalledTimes(1)
			expect(shellMnemonicSync.sync).toHaveBeenCalledWith(base.rec.mnemonicPhrase, base.rec.profiles[0].keyID.toLowerCase())
		})

		it(`${mode}: plaintext migration (production start read), then persistInitRecord: decrypted read-back unchanged (criterion a)`, async () => {
			await seed(shell, 'plain', base.rec)
			const before = await readBack()
			await mod.checkStorageWithStatus()
			globals.setCoNET_Data(clone(base.rec))
			await mod.persistInitRecord(clone(globals.CoNET_Data))
			expect(JSON.stringify(await readBack())).toBe(JSON.stringify(before))
		})
	}

	// criterion (b): the stored bytes of a slot that must not change. An empty in-memory slot keeps the stored wrap.
	it('browser: an empty in-memory privateKeyArmor keeps the stored wrap byte for byte (criterion b)', async () => {
		// unit f3: the stored wrap is a passcode (v3) record, so the passcode is set first (no device-key wraps exist any more)
		await seed(false, 'plain', browserFixtures[0].rec)
		globals.setCoNET_Data(clone(browserFixtures[0].rec))
		expect((await mod.setWalletVaultPasscode(P1)).ok).toBe(true)
		await mod.persistInitRecord(clone(globals.CoNET_Data))
		const storedBefore = raw(false) as Loose
		const wrapBefore = JSON.stringify(storedBefore.profiles[0].privateKeyArmor)
		expect(wrapBefore.startsWith('{')).toBe(true)
		const mem = clone(browserFixtures[0].rec)
		mem.profiles[0].privateKeyArmor = ''
		globals.setCoNET_Data(mem)
		await mod.persistInitRecord(clone(mem))
		const storedAfter = raw(false) as Loose
		expect(JSON.stringify(storedAfter.profiles[0].privateKeyArmor)).toBe(wrapBefore)
		expect(JSON.stringify(await readBack())).toBe(JSON.stringify(norm(browserFixtures[0].rec)))
	})

	it('shell: an empty in-memory privateKeyArmor leaves the native copy byte for byte (criterion b)', async () => {
		await seed(true, 'plain', shellFixtures[0].rec)
		const before = raw(true) as Loose
		const mem = clone(shellFixtures[0].rec)
		mem.profiles[0].privateKeyArmor = ''
		globals.setCoNET_Data(mem)
		await mod.persistInitRecord(clone(mem))
		const after = raw(true) as Loose
		expect(JSON.stringify(after.profiles[0].privateKeyArmor)).toBe(JSON.stringify(before.profiles[0].privateKeyArmor))
		expect(JSON.stringify(after.mnemonicPhrase)).toBe(JSON.stringify(before.mnemonicPhrase))
	})

	// characterization (current behaviour, for the independent review): a page copy whose profile carries an empty pgpKey
	// object is refused by the shell write whitelist. Not a pass of the shell path; the result is stated, the code is not changed.
	it('shell: a page copy with an empty profile pgpKey object is refused by the write whitelist (characterization)', async () => {
		await seed(true, 'plain', shellFixtures[0].rec)
		const mem = clone(shellFixtures[0].rec) as Loose
		mem.profiles[0].pgpKey = {}
		globals.setCoNET_Data(mem)
		await expect(mod.persistInitRecord(clone(mem))).rejects.toThrow('pgp_field_not_allowed')
	})

	// characterization (current behaviour, for the independent review): on the shell, setting a passcode returns 'error' and
	// the native copy is left unchanged (no data lost). The cause is inferred from walletVault.ts verifyWrapped (the page write
	// strips W-class fields, so the native copy never holds the wrap that verify reads back). Not asserted as a pass.
	it('shell: setting a passcode returns error and leaves the native copy unchanged (characterization)', async () => {
		await seed(true, 'plain', shellFixtures[0].rec)
		const before = raw(true)
		globals.setCoNET_Data(clone(shellFixtures[0].rec))
		const res = await mod.setWalletVaultPasscode(P1)
		expect(res).toEqual({ ok: false, reason: 'error' })
		// canonical key order: the native merge's key order is not part of the record
		expect(JSON.stringify(norm(raw(true)))).toBe(JSON.stringify(norm(before)))
	})

	// the old-store entry with a chat container (synthetic, 0.52.930-shaped; SilentPassUI b4bf1a90 chat.ts:347-353). After the approved
	// fix (stripLegacyChatContainers in the legacy entry, beamio.ts readStorageWithStatus): the first shell save succeeds, the payload
	// that leaves the page carries only allowed fields, the old store is byte for byte unchanged, and the restart reads.
	// SKIPPED, superseded (skip reason 1 of 4): the decision (start reads the page IndexedDB first) and item 1 (a shell save writes the
	// page copy first, so the old store's _rev changes by design). The save-then-restart value is covered by startupIdbFirst 'item 1'. Not run.
	it.skip('shell: an old-store record with a chat container: the first save succeeds, the payload is allowed, the old store is unchanged', async () => {
		const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __shellMode?: boolean; __shellLastPayload?: Loose }
		pouchDbs.clear()
		g.__shellRev = 0
		g.__shellMode = true
		g.__shellLastPayload = undefined
		const oldRecord = {
			mnemonicPhrase: PHRASE_A,
			isReady: true,
			// the five PGP public paths of the shell write (shellRecordSanitizer.pgpPublicPaths), with a chat peer and empty strings too
			beamio: { pgpPublicKeyID: '', pgpPublicKeyArmor: 'SYNTHETIC-BEAMIO-ARMOR', userName: 'old-name' },
			profiles: [
				{
					keyID: A.keyID,
					privateKeyArmor: A.privateKeyArmor,
					userName: 'old-name',
					chatManager: {
						router: '',
						pgpKey: { keyID: 'synthetic-pgp-keyid', publicKey: 'SYNTHETIC-PUBLIC-ARMOR', privateKey: 'SYNTHETIC-PRIVATE-ARMOR', routes: '' },
					},
					chats: [{ peer: 'synthetic-peer', chatData: { publicArmored: 'SYNTHETIC-PEER-ARMOR', msgs: [] } }],
				},
			],
		}
		// the native copy already holds the account's wallet fields (what the pwaWalletSync sync leaves there); no PGP fields
		g.__shellStore = { mnemonicPhrase: PHRASE_A, isReady: true, profiles: [{ keyID: A.keyID, privateKeyArmor: A.privateKeyArmor, userName: 'old-name' }] }
		const oldTitle = encodeInitRaw(oldRecord)
		pouchDbs.set('conet', new Map([['init', { _id: 'init', _rev: '1-old', title: oldTitle }]]))
		holdShellSessionFromPhrase(PHRASE_A, A.keyID)

		;(globalThis as { __nativeEoa?: unknown }).__nativeEoa = { kind: 'address', eoa: A.keyID }
		// 1. the start read: the native record of the same account is used; the page copy has no PGP container
		const start = await mod.checkStorageWithStatus()
		expect(start.status).toBe('loaded')
		expect(JSON.stringify(globals.CoNET_Data)).not.toContain('pgpKey')
		expect(JSON.stringify(globals.CoNET_Data)).not.toContain('SYNTHETIC-')
		// 0.53.44: the page write gate is closed by default; this case is an account that is open (a valid page mnemonic entry)
		mod.setPageWritePermit('page_valid_mnemonic')
		expect(await mod.storeSystemDataAndWait()).toBe(true)
		expect(isPersistFailed()).toBe(false)

		// 2. the user edits a page-editable field; the save succeeds
		const edited = clone(globals.CoNET_Data) as Loose
		edited.profiles[0].userName = 'edited-name'
		globals.setCoNET_Data(edited)
		await expect(mod.persistInitRecord(clone(edited))).resolves.toBeUndefined()
		expect(isPersistFailed()).toBe(false)

		// 3. the payload that left the page: the allowed fields only (no wallet fields, no PGP, no chat container)
		const payload = (g.__shellLastPayload ?? {}) as Loose
		expect(payload).toBeDefined()
		expect(JSON.stringify(payload)).not.toMatch(/privateKeyArmor|mnemonicPhrase|pgpKey|publicArmored|SYNTHETIC-/)
		expect(payload.profiles[0].userName).toBe('edited-name')
		expect(payload.rev).toBeDefined()
		expect(payload.schemaVersion).toBeDefined()
		// the native copy keeps its own wallet fields and takes the edit
		expect((g.__shellStore as Loose).mnemonicPhrase).toBe(PHRASE_A)
		expect((g.__shellStore as Loose).profiles[0].privateKeyArmor).toBe(A.privateKeyArmor)
		expect((g.__shellStore as Loose).profiles[0].userName).toBe('edited-name')

		// 4. the old store is byte for byte unchanged
		const oldDoc = pouchDbs.get('conet')?.get('init')
		expect(oldDoc?._rev).toBe('1-old')
		expect(oldDoc?.title).toBe(oldTitle)

		// 5. a restart: the start read again. The legacy entry is read first, so the old store's record is the one entered.
		globals.setCoNET_Data(null)
		const restart = await mod.checkStorageWithStatus()
		expect(restart.status).toBe('loaded')
		// the native record of the same account is newer and is used: the saved edit comes back, the old store is not entered over it
		expect((restart as Loose).data.profiles[0].userName).toBe('edited-name')
		expect(pouchDbs.get('conet')?.get('init')?._rev).toBe('1-old')
	})

	// rule, the shell start read order: the native record first; the old store only when the native side is confirmed empty;
	// a native unknown is a hold (nothing is read from the old store, nothing is written); the same-account native record is never overwritten.
	describe('shell start read order', () => {
		const native = (g: { __shellStore?: unknown }, rec: Loose) => {
			g.__shellStore = clone(rec)
		}
		const nativeRecordOf = (phrase: string, a: { keyID: string; privateKeyArmor: string }, userName: string): Loose => ({
			mnemonicPhrase: phrase,
			isReady: true,
			profiles: [{ keyID: a.keyID, privateKeyArmor: a.privateKeyArmor, userName }],
		})
		const oldRecordOf = (phrase: string, a: { keyID: string; privateKeyArmor: string }, userName: string): Loose => ({
			mnemonicPhrase: phrase,
			isReady: true,
			profiles: [{ keyID: a.keyID, privateKeyArmor: a.privateKeyArmor, userName }],
		})
		const setup = (oldPhrase: string, oldRec: Loose | null) => {
			const g = globalThis as { __shellStore?: unknown; __shellRev?: number; __shellMode?: boolean; __nativeEoa?: unknown }
			pouchDbs.clear()
			g.__shellStore = undefined
			g.__shellRev = 0
			g.__shellMode = true
			g.__nativeEoa = undefined
			if (oldRec) pouchDbs.set('conet', new Map([['init', { _id: 'init', _rev: '1-old', title: encodeInitRaw(oldRec) }]]))
			holdShellSessionFromPhrase(oldPhrase, ((oldRec?.profiles as Loose[] | undefined)?.[0]?.keyID as string | undefined) ?? A.keyID)
			return g
		}

		// SKIPPED, superseded (skip reason 2 of 4): the decision: the start copy is the page IndexedDB; the native record is not read at start (startupIdbFirst 'zero native record reads'). Not run.
		it.skip('a native record of the same account is used; the old store is not entered over it', async () => {
			const g = setup(PHRASE_A, oldRecordOf(PHRASE_A, A, 'old-name'))
			native(g, nativeRecordOf(PHRASE_A, A, 'native-name'))
			g.__nativeEoa = { kind: 'address', eoa: A.keyID }
			const start = await mod.checkStorageWithStatus()
			expect(start.status).toBe('loaded')
			expect((start as Loose).data.profiles[0].userName).toBe('native-name')
		})

		it('a native record of another account: the old store entry stays as before (r94), the native record is not overwritten by a start', async () => {
			const g = setup(PHRASE_B, oldRecordOf(PHRASE_B, B, 'old-b'))
			native(g, nativeRecordOf(PHRASE_A, A, 'native-a'))
			g.__nativeEoa = { kind: 'address', eoa: A.keyID }
			const start = await mod.checkStorageWithStatus()
			expect(start.status).toBe('loaded')
			expect((start as Loose).data.profiles[0].keyID).toBe(B.keyID)
			// the start does not write the native record (the entry is read-only)
			expect((g.__shellStore as Loose).profiles[0].userName).toBe('native-a')
		})

		it('native confirmed empty: the old store is used', async () => {
			setup(PHRASE_A, oldRecordOf(PHRASE_A, A, 'old-name'))
			const start = await mod.checkStorageWithStatus()
			expect(start.status).toBe('loaded')
			expect((start as Loose).data.profiles[0].userName).toBe('old-name')
		})

		it('the old store is wiped and the native side has no record: onboarding (the wallet restore entry), and the chat identity create action is unreachable', async () => {
			const g = setup(PHRASE_A, null) // no old store document, no native record
			g.__shellStore = undefined
			const start = await mod.checkStorageWithStatus()
			expect(start.status).toBe('empty') // onboarding; the restore entry is there for the user
			const { pgpCreateEligible } = require('./pgpIdentityEligibility')
			const { nativeGenerateNewPgpKey } = require('./nativePgpRestore')
			expect(pgpCreateEligible(A.keyID)).toBe(false)
			await expect(nativeGenerateNewPgpKey(A.keyID)).resolves.toEqual({ ok: false, reason: 'not_eligible' })
		})

		// SKIPPED, superseded (skip reason 3 of 4): the decision: a valid page IndexedDB enters whatever the native store answers (startupIdbFirst, valid + native not_ready). Not run.
		it.skip('native unknown: a hold, the old store is not read into the page, nothing is written, the old store is unchanged', async () => {
			const g = setup(PHRASE_A, oldRecordOf(PHRASE_A, A, 'old-name'))
			g.__shellStore = '__unknown__'
			const before = pouchDbs.get('conet')?.get('init')
			const start = await mod.checkStorageWithStatus()
			expect(start.status).toBe('unavailable')
			expect(g.__shellStore).toBe('__unknown__')
			expect(pouchDbs.get('conet')?.get('init')).toEqual(before)
		})

		// SKIPPED, superseded (skip reason 4 of 4): the restart reads the page IndexedDB copy first () and the native copy is synced in the background ( item 1); the 'native is never overwritten by a later save' assertion no longer holds. Not run.
		it.skip('after a change and a restart the change is kept, and a later save does not overwrite the newer native record with the old one', async () => {
			const g = setup(PHRASE_A, oldRecordOf(PHRASE_A, A, 'old-name'))
			native(g, nativeRecordOf(PHRASE_A, A, 'old-name'))
			g.__nativeEoa = { kind: 'address', eoa: A.keyID }
			const first = await mod.checkStorageWithStatus()
			expect(first.status).toBe('loaded')
			const edited = clone(globals.CoNET_Data) as Loose
			edited.profiles[0].userName = 'edited-name'
			globals.setCoNET_Data(edited)
			await expect(mod.persistInitRecord(clone(edited))).resolves.toBeUndefined()
			// restart
			globals.setCoNET_Data(null)
			const restart = await mod.checkStorageWithStatus()
			expect((restart as Loose).data.profiles[0].userName).toBe('edited-name')
			// a later save of the page copy (the copy the restart read) keeps the newer native value
			await expect(mod.persistInitRecord(clone(restart.data as unknown as Loose))).resolves.toBeUndefined()
			expect((g.__shellStore as Loose).profiles[0].userName).toBe('edited-name')
			expect(pouchDbs.get('conet')?.get('init')?._rev).toBe('1-old')
		})
	})
})
