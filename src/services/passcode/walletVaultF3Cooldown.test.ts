/**
 * @jest-environment node
 *
 * Unit f3 (2026-11-22): the persistent cooldown per account (passcodeAttemptRecordStore in the PWA IndexedDB).
 * Covers: a refresh inside the lock still locked; the 3rd wrong locks 5 min; a wrong after the lock locks 5 min again; success clears and
 * deletes the record; a clock that ran back restarts the full 5 min; read and write failures refuse the attempt without comparing the
 * passcode; two tabs counting at once lose no count.
 * The KDF here is a TEST DOUBLE (a fast Argon2id stand-in through the injection points) so the cooldown runs stay inside the jest timeout; the
 * production Argon2id parameters are exercised in walletVaultF3Legacy.test.ts. SYNTHETIC values only. Nothing touches real storage.
 */
import { argon2idAsync } from '@noble/hashes/argon2'
import { setPasscodeKdfForTest, type PasscodeKdf } from './walletWrap'
import { setMnemonicKdfForTest } from './mnemonicCipherV3'
import { disableWalletPasscode, lockWalletSession, resetWalletSession, setWalletPasscode, unlockWalletPasscode, type WalletMeta, type WalletStores } from './walletVault'
import { LOCK_MS } from './passcodeBackoff'
import { type AtomicKeyValueDb, memoryAtomicKeyValueDb, passcodeAttemptRecordStore } from './passcodeWrapStore'
import { webcrypto } from 'crypto'

// the shell flag: a toggle for the set-passcode tests (false by default, as in the browser)
jest.mock('../shellContext', () => ({ isShellContext: () => (globalThis as { __shellMode?: boolean }).__shellMode === true }))
// TEST DOUBLE ONLY (unit f3): a fast Argon2id stand-in (the same algorithm at reduced m and t) through the production injection points, so
// the suite stays inside the jest timeout. The production parameters (m 32 MiB, t 3) are exercised in walletVaultF3Legacy.test.ts.
const fastArgon2: PasscodeKdf = (password, salt, opts) => argon2idAsync(password, salt, { ...opts, m: 1024, t: 1, p: 1 })
beforeAll(() => {
	setPasscodeKdfForTest(fastArgon2)
	setMnemonicKdfForTest(fastArgon2)
})
afterAll(() => {
	setPasscodeKdfForTest(null)
	setMnemonicKdfForTest(null)
})

if (!(globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94' // the account of the public BIP-39 test phrase below
const KEY = '0x' + '11'.repeat(32)
const PASS = '395784'
const WRONG = '571936'
const T0 = 1_800_000_000_000

/** Wallet stores whose cooldown record lives in one shared atomic db (one account), with optional failure injection. */
function harness(opts: { db?: AtomicKeyValueDb & { raw: Map<string, unknown> } } = {}) {
	let initJson: string | null = JSON.stringify({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }], mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })
	const db = opts.db ?? memoryAtomicKeyValueDb()
	const fail = { read: false, write: false }
	const wrapped: AtomicKeyValueDb = {
		get: async (k) => {
			if (fail.read) throw new Error('io_read')
			return db.get(k)
		},
		put: (k, v) => db.put(k, v),
		delete: (k) => db.delete(k),
		update: (k, fn) => {
			// a failed read inside the transaction makes the whole update fail (nothing is written, nothing is compared)
			if (fail.read) return Promise.reject(new Error('io_read'))
			if (fail.write) return Promise.reject(new Error('io_write'))
			return db.update(k, fn)
		},
	}
	const meta = { failures: 0, nextAt: 0 } as WalletMeta
	const stores: WalletStores = {
		readInit: async () => JSON.parse(initJson as string),
		writeInit: async (d) => {
			initJson = JSON.stringify(d)
		},
		readMeta: async () => meta,
		writeMeta: async () => undefined,
		attemptsFor: (e: string) => passcodeAttemptRecordStore(wrapped, e),
	}
	return { stores, db, fail, record: () => (db.raw.get(`passcodeAttempt:${EOA.toLowerCase()}`) ?? null) as Record<string, number> | null }
}

const pass = () => harness()

beforeEach(() => {
	resetWalletSession()
})

async function setUp(h: ReturnType<typeof harness>) {
	const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
	const r = await setWalletPasscode(h.stores, PASS, plain)
	expect(r).toEqual({ ok: true })
	lockWalletSession()
}

describe('cooldown: 3 wrong locks 5 min, a refresh stays locked, a wrong after the lock locks 5 min again, success clears', () => {
	it('runs the full sequence and the record is deleted on success', async () => {
		const h = pass()
		await setUp(h)

		expect(await unlockWalletPasscode(h.stores, WRONG, T0)).toMatchObject({ ok: false, reason: 'wrong_passcode', attempts: 1, retryAfterMs: 0 })
		expect(await unlockWalletPasscode(h.stores, WRONG, T0 + 1)).toMatchObject({ ok: false, reason: 'wrong_passcode', attempts: 2, retryAfterMs: 0 })
		// the 3rd wrong triggers the 5-minute lock
		expect(await unlockWalletPasscode(h.stores, WRONG, T0 + 2)).toMatchObject({ ok: false, reason: 'wrong_passcode', attempts: 3, retryAfterMs: LOCK_MS })
		expect(h.record()).toMatchObject({ failures: 3, lockedUntilMs: T0 + 2 + LOCK_MS, lastFailureMs: T0 + 2 })

		// refresh (a new call, same stored record) inside the lock: still locked, the right passcode is not compared
		expect(await unlockWalletPasscode(h.stores, PASS, T0 + 60_000)).toEqual({ ok: false, reason: 'backoff', retryAfterMs: LOCK_MS - 59_998 })

		// after the lock: one wrong locks again for the full 5 minutes (the count is kept)
		expect(await unlockWalletPasscode(h.stores, WRONG, T0 + 2 + LOCK_MS)).toMatchObject({ ok: false, reason: 'wrong_passcode', attempts: 4, retryAfterMs: LOCK_MS })
		expect(await unlockWalletPasscode(h.stores, PASS, T0 + 2 + LOCK_MS + 1000)).toEqual({ ok: false, reason: 'backoff', retryAfterMs: LOCK_MS - 1000 })

		// after that lock: the right passcode succeeds and the record is deleted
		const ok = await unlockWalletPasscode(h.stores, PASS, T0 + 2 + 2 * LOCK_MS + 1)
		expect(ok.ok).toBe(true)
		expect(h.record()).toBeNull()
	}, 60_000)
})

describe('clock rollback', () => {
	it('a clock that ran back restarts the full 5 minutes from now (fail closed), even for the right passcode', async () => {
		const h = pass()
		await setUp(h)
		await unlockWalletPasscode(h.stores, WRONG, T0 + 10_000)
		// now is earlier than the last recorded failure
		expect(await unlockWalletPasscode(h.stores, PASS, T0)).toEqual({ ok: false, reason: 'backoff', retryAfterMs: LOCK_MS })
		expect(h.record()).toMatchObject({ lockedUntilMs: T0 + LOCK_MS, lastFailureMs: T0 })
	}, 60_000)
})

describe('read and write failures refuse the attempt; the passcode is not compared', () => {
	it('a failed read refuses (error), and the passcode is not checked', async () => {
		const h = pass()
		await setUp(h)
		h.fail.read = true
		expect(await unlockWalletPasscode(h.stores, PASS, T0)).toEqual({ ok: false, reason: 'error' })
		h.fail.read = false
		// nothing was written and nothing was compared; the next attempt is judged again once the store reads
		expect(h.record()).toBeNull()
		expect(await unlockWalletPasscode(h.stores, PASS, T0 + 1)).toMatchObject({ ok: true })
	})

	it('a failed count write refuses (error) before any comparison; the next attempt is judged again after the store recovers', async () => {
		const h = pass()
		await setUp(h)
		h.fail.write = true
		expect(await unlockWalletPasscode(h.stores, WRONG, T0)).toEqual({ ok: false, reason: 'error' })
		expect(h.record()).toBeNull()
		h.fail.write = false
		expect(await unlockWalletPasscode(h.stores, WRONG, T0 + 1)).toMatchObject({ ok: false, reason: 'wrong_passcode', attempts: 1 })
	}, 60_000)

	it('a failed clear after a right passcode refuses the unlock (error), so no session is granted', async () => {
		const h = pass()
		await setUp(h)
		await unlockWalletPasscode(h.stores, WRONG, T0)
		// the first update (count) succeeds; the second (clear after the right passcode) fails
		const inner = h.db
		let calls = 0
		const update = inner.update.bind(inner)
		inner.update = (k, fn) => {
			calls += 1
			if (calls === 2) return Promise.reject(new Error('io_write'))
			return update(k, fn)
		}
		expect(await unlockWalletPasscode(h.stores, PASS, T0 + LOCK_MS + 1)).toEqual({ ok: false, reason: 'error' })
		expect(h.record()).toMatchObject({ failures: 2 })
	}, 60_000)
})

describe('two tabs counting at once (one IndexedDB, atomic increment)', () => {
	it('two concurrent wrong attempts are both counted: no count is lost', async () => {
		const db = memoryAtomicKeyValueDb()
		const a = harness({ db })
		await setUp(a)
		const b = harness({ db })
		// the two tabs share the account record in the same db (each tab holds the same wallet)
		await setUp(b)
		const [r1, r2] = await Promise.all([unlockWalletPasscode(a.stores, WRONG, T0), unlockWalletPasscode(b.stores, WRONG, T0 + 1)])
		expect([r1.ok, r2.ok]).toEqual([false, false])
		expect(a.record()).toMatchObject({ failures: 2 })
	}, 60_000)
})

describe('disable: verify, plaintext write and read-back, cipher replaced, cooldown cleared, then the background sync', () => {
	it('a wrong passcode does not write, does not clear the cooldown record, and does not sync', async () => {
		const h = pass()
		await setUp(h)
		const sync = jest.fn()
		const res = await disableWalletPasscode(h.stores, WRONG, T0, sync)
		expect(res).toMatchObject({ ok: false, reason: 'wrong_passcode' })
		expect(sync).not.toHaveBeenCalled()
		expect(h.record()).toMatchObject({ failures: 1 })
	}, 60_000)

	it('the right passcode: plaintext on disk, cooldown record deleted, sync called once with the phrase and the account', async () => {
		const h = pass()
		await setUp(h)
		const sync = jest.fn()
		const res = await disableWalletPasscode(h.stores, PASS, T0 + 1, sync)
		expect(res).toEqual({ ok: true })
		const back = (await h.stores.readInit()) as { mnemonicPhrase: unknown }
		expect(back.mnemonicPhrase).toBe('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
		expect(h.record()).toBeNull()
		expect(sync).toHaveBeenCalledTimes(1)
		expect(sync).toHaveBeenCalledWith('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', EOA.toLowerCase())
	}, 60_000)
})

describe('set passcode: the first pwaWalletSync with the passcode completes the set only when confirmed (passcodeSetSync, f2)', () => {
	it('the first sync gets the v3 mnemonic envelope and the passcode once, and the set completes on ok', async () => {
		const h = pass()
		const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
		const firstSync = jest.fn(async () => 'ok' as const)
		const r = await setWalletPasscode(h.stores, PASS, plain, firstSync)
		expect(r).toEqual({ ok: true })
		expect(firstSync).toHaveBeenCalledTimes(1)
		const [env, pc] = firstSync.mock.calls[0] as unknown as [Record<string, unknown>, string]
		expect(env).toMatchObject({ v: 3, mode: 'passcode', alg: 'AES-256-GCM', eoa: EOA.toLowerCase() })
		expect(pc).toBe(PASS)
	}, 120_000)

	it('a sync that is not confirmed does not complete the set (pending, see below)', async () => {
		const h = pass()
		const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
		const r = await setWalletPasscode(h.stores, PASS, plain, async () => 'not_completed')
		expect(r).toMatchObject({ ok: false, reason: 'sync_pending' })
	}, 120_000)

	it('a weak passcode is refused before anything is sent', async () => {
		const h = pass()
		const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
		const firstSync = jest.fn(async () => 'ok' as const)
		expect((await setWalletPasscode(h.stores, '123456', plain, firstSync)).ok).toBe(false)
		expect(firstSync).not.toHaveBeenCalled()
	})
})

describe('set passcode: the shell must inject the first sync; a pending sync is not a completed set (f3 follow-up, items 2 and 3)', () => {
	afterEach(() => {
		;(globalThis as { __shellMode?: boolean }).__shellMode = false
	})

	it('in the shell without the injected first sync: an error, and nothing is written', async () => {
		const h = pass()
		const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
		const before = JSON.stringify(await h.stores.readInit())
		;(globalThis as { __shellMode?: boolean }).__shellMode = true
		expect(await setWalletPasscode(h.stores, PASS, plain)).toEqual({ ok: false, reason: 'error' })
		expect(JSON.stringify(await h.stores.readInit())).toBe(before)
		expect(h.record()).toBeNull()
	}, 60_000)

	it('a first sync that is not confirmed: sync_pending, the record is written with the v3 envelope, and the envelope is returned for the background sync', async () => {
		const h = pass()
		const plain = JSON.parse(JSON.stringify(await h.stores.readInit()))
		const r = await setWalletPasscode(h.stores, PASS, plain, async () => 'not_completed')
		expect(r.ok).toBe(false)
		expect(r).toMatchObject({ reason: 'sync_pending' })
		const stored = (await h.stores.readInit()) as { mnemonicPhrase: Record<string, unknown> }
		expect(stored.mnemonicPhrase).toMatchObject({ v: 3, mode: 'passcode' })
		expect((r as { cipher: unknown }).cipher).toEqual(stored.mnemonicPhrase)
	}, 120_000)
})
