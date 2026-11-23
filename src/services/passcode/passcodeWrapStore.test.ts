/**
 * The page passcode documents, keyed per account (r2c §二, §9.2, §10). SYNTHETIC values only. The in-memory KeyValueDb stands in for IndexedDB.
 */
import { passcodeAttemptStore, passcodeWrapStore, mainKey, stagingKey, attemptKey, PASSCODE_DB_NAME, PASSCODE_STORE, type KeyValueDb } from './passcodeWrapStore'
import { attemptUnlock, LOCK_MS, ZERO_ATTEMPTS } from './passcodeBackoff'
import type { WrapRecord } from './walletWrap'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER = '0x1111111111111111111111111111111111111111'

type MemDb = KeyValueDb & { raw: Map<string, unknown>; failPut: Set<string>; failGet: Set<string>; corruptGet: Map<string, unknown> }
const memDb = (): MemDb => {
	const raw = new Map<string, unknown>()
	const db: MemDb = {
		raw,
		failPut: new Set(),
		failGet: new Set(),
		corruptGet: new Map(),
		async get(key: string) {
			if (db.failGet.has(key)) throw new Error('db_down')
			if (db.corruptGet.has(key)) return db.corruptGet.get(key)
			return raw.has(key) ? JSON.parse(JSON.stringify(raw.get(key))) : undefined
		},
		async put(key: string, value: unknown) {
			if (db.failPut.has(key)) throw new Error('db_put_down')
			raw.set(key, JSON.parse(JSON.stringify(value)))
		},
		async delete(key: string) {
			raw.delete(key)
		},
	}
	return db
}

const WRAP: WrapRecord = { v: 3, mode: 'passcode', eoa: EOA, kdf: 'argon2id-aes256gcm/m32768/t3/p1', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' } as WrapRecord
const WRAP2: WrapRecord = { ...WRAP, ct: 'Y3Qy' } as WrapRecord

describe('frozen names and per-account keys (r2c §二.1)', () => {
	it('database and store are the frozen names', () => {
		expect(PASSCODE_DB_NAME).toBe('beamio-passcode-v1')
		expect(PASSCODE_STORE).toBe('records')
	})
	it('keys are per account and lower-cased', () => {
		expect(mainKey(EOA.toUpperCase().replace('0X', '0x'))).toBe(`passcodeWrap:${EOA}`)
		expect(stagingKey(EOA)).toBe(`passcodeWrap:${EOA}.staging`)
		expect(attemptKey(EOA)).toBe(`passcodeAttempt:${EOA}`)
	})
})

describe('staged write (§9.2)', () => {
	it('stages, reads back, replaces the main record and removes the staged copy', async () => {
		const db = memDb()
		await passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP)
		expect(await passcodeWrapStore(db, EOA).readWrap('mnemonic')).toEqual(WRAP)
		expect(db.raw.has(stagingKey(EOA))).toBe(false)
		expect(db.raw.has(mainKey(EOA))).toBe(true)
	})

	it('a readback mismatch removes the staged copy and keeps the main record byte-for-byte', async () => {
		const db = memDb()
		await passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP)
		const before = JSON.stringify(db.raw.get(mainKey(EOA)))
		db.corruptGet.set(stagingKey(EOA), { eoa: EOA.toLowerCase(), wraps: {} })
		await expect(passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP2)).rejects.toThrow('readback_mismatch')
		db.corruptGet.clear()
		expect(db.raw.has(stagingKey(EOA))).toBe(false)
		expect(JSON.stringify(db.raw.get(mainKey(EOA)))).toBe(before)
	})

	it('a failed staging write keeps the main record and reports write_failed', async () => {
		const db = memDb()
		await passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP)
		const before = JSON.stringify(db.raw.get(mainKey(EOA)))
		db.failPut.add(stagingKey(EOA))
		await expect(passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP2)).rejects.toThrow('write_failed')
		db.failPut.clear()
		expect(JSON.stringify(db.raw.get(mainKey(EOA)))).toBe(before)
	})

	it('a failed main write keeps the old main bytes and leaves the staged copy (not promoted)', async () => {
		const db = memDb()
		await passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP)
		const before = JSON.stringify(db.raw.get(mainKey(EOA)))
		db.failPut.add(mainKey(EOA))
		await expect(passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP2)).rejects.toThrow('write_failed')
		db.failPut.clear()
		expect(JSON.stringify(db.raw.get(mainKey(EOA)))).toBe(before)
		expect(db.raw.has(stagingKey(EOA))).toBe(true)
	})
})

describe('startup with a staged copy (§9.2)', () => {
	it('a staged copy with no main record is never promoted and reads as identity pending', async () => {
		const db = memDb()
		db.raw.set(stagingKey(EOA), { eoa: EOA.toLowerCase(), wraps: { mnemonic: WRAP } })
		const store = passcodeWrapStore(db, EOA)
		expect(await store.identityPending()).toBe(true)
		expect(await store.readWrap('mnemonic')).toBeNull()
		expect(db.raw.has(mainKey(EOA))).toBe(false)
		expect(db.raw.has(stagingKey(EOA))).toBe(true)
	})
})

describe('two accounts are independent (§10, r2c §三)', () => {
	it('account B can set its wrap while account A has a main record; B never touches A', async () => {
		const db = memDb()
		await passcodeWrapStore(db, OTHER).writeWrap('mnemonic', { ...WRAP, eoa: OTHER } as WrapRecord)
		const aBefore = JSON.stringify(db.raw.get(mainKey(OTHER)))
		await passcodeWrapStore(db, EOA).writeWrap('mnemonic', WRAP)
		expect(JSON.stringify(db.raw.get(mainKey(OTHER)))).toBe(aBefore)
		expect(await passcodeWrapStore(db, EOA).readWrap('mnemonic')).toEqual(WRAP)
		expect(await passcodeWrapStore(db, OTHER).readWrap('mnemonic')).toEqual({ ...WRAP, eoa: OTHER })
	})

	it('a staged copy of one account never blocks or promotes for another', async () => {
		const db = memDb()
		db.raw.set(stagingKey(OTHER), { eoa: OTHER, wraps: { mnemonic: { ...WRAP, eoa: OTHER } } })
		expect(await passcodeWrapStore(db, EOA).identityPending()).toBe(false)
		expect(await passcodeWrapStore(db, EOA).readWrap('mnemonic')).toBeNull()
	})

	it('the legacy single keys are never read', async () => {
		const db = memDb()
		db.raw.set('passcodeWrap', { eoa: EOA.toLowerCase(), wraps: { mnemonic: WRAP } })
		expect(await passcodeWrapStore(db, EOA).readWrap('mnemonic')).toBeNull()
	})

	it('a malformed main record throws on read (unknown), never reads as absent', async () => {
		const db = memDb()
		db.raw.set(mainKey(EOA), { eoa: EOA.toLowerCase(), wraps: { mnemonic: { v: 2 } } })
		await expect(passcodeWrapStore(db, EOA).readWrap('mnemonic')).rejects.toThrow('passcode_wrap_malformed')
	})

	it('a main record whose eoa does not match its key is malformed, not another account', async () => {
		const db = memDb()
		db.raw.set(mainKey(EOA), { eoa: OTHER, wraps: { mnemonic: WRAP } })
		await expect(passcodeWrapStore(db, EOA).readWrap('mnemonic')).rejects.toThrow('passcode_wrap_malformed')
	})

	it('a malformed wrap is refused on write before anything is staged', async () => {
		const db = memDb()
		await expect(passcodeWrapStore(db, EOA).writeWrap('mnemonic', { v: 2 } as unknown as WrapRecord)).rejects.toThrow('passcode_wrap_malformed')
		expect(db.raw.size).toBe(0)
	})
})

describe('attempt counter (passcodeAttempt:<eoa>, r2c §二.2–§二.3)', () => {
	it('a missing document reads as null, so the first attempt starts from zero', async () => {
		expect(await passcodeAttemptStore(memDb(), EOA).read()).toBeNull()
	})

	it('a write then a read round-trips for this account, under its own key', async () => {
		const db = memDb()
		await passcodeAttemptStore(db, EOA).write({ failures: 2, lockedUntilMs: 0, lastFailureMs: 1000 })
		expect(db.raw.has(attemptKey(EOA))).toBe(true)
		expect(await passcodeAttemptStore(db, EOA).read()).toEqual({ failures: 2, lockedUntilMs: 0, lastFailureMs: 1000 })
	})

	it('account A locked does not affect account B (A’s lock does not block B’s unlock)', async () => {
		const db = memDb()
		const verify = jest.fn(async () => false)
		const now = 1_000_000
		for (let i = 0; i < 3; i++) await attemptUnlock(passcodeAttemptStore(db, EOA), now + i, verify)
		expect((await attemptUnlock(passcodeAttemptStore(db, EOA), now + 5, verify)).kind).toBe('locked')
		const verifyB = jest.fn(async () => true)
		expect((await attemptUnlock(passcodeAttemptStore(db, OTHER), now + 5, verifyB)).kind).toBe('correct')
		expect(verifyB).toHaveBeenCalledTimes(1)
	})

	it('switching accounts does not clear the counter; only the same account’s correct unlock clears it', async () => {
		const db = memDb()
		const verify = jest.fn(async () => false)
		const now = 2_000_000
		for (let i = 0; i < 3; i++) await attemptUnlock(passcodeAttemptStore(db, EOA), now + i, verify)
		// the other account is used and then the first returns: still locked
		await attemptUnlock(passcodeAttemptStore(db, OTHER), now + 3, async () => true)
		expect((await attemptUnlock(passcodeAttemptStore(db, EOA), now + 5, verify)).kind).toBe('locked')
	})

	it('a counter that is malformed throws, never reads as zero', async () => {
		const db = memDb()
		db.raw.set(attemptKey(EOA), { eoa: EOA.toLowerCase(), failures: -1, lockedUntilMs: 0, lastFailureMs: 0 })
		await expect(passcodeAttemptStore(db, EOA).read()).rejects.toThrow('passcode_attempt_malformed')
	})

	it('a counter whose eoa does not match its key throws', async () => {
		const db = memDb()
		db.raw.set(attemptKey(EOA), { eoa: OTHER, failures: 2, lockedUntilMs: 0, lastFailureMs: 1000 })
		await expect(passcodeAttemptStore(db, EOA).read()).rejects.toThrow('passcode_attempt_malformed')
	})

	it('a database failure propagates, so attemptUnlock refuses with read_failed', async () => {
		const db = memDb()
		db.failGet.add(attemptKey(EOA))
		expect(await attemptUnlock(passcodeAttemptStore(db, EOA), 1000, async () => true)).toEqual({ kind: 'refused', reason: 'read_failed' })
	})

	it('the three-strike lock survives a reload: the count is in the document before the judgement', async () => {
		const db = memDb()
		const verify = jest.fn(async () => false)
		const now = 1_000_000
		for (let i = 0; i < 3; i++) await attemptUnlock(passcodeAttemptStore(db, EOA), now + i, verify)
		const again = await attemptUnlock(passcodeAttemptStore(db, EOA), now + 5, verify)
		expect(again.kind).toBe('locked')
		expect(verify).toHaveBeenCalledTimes(3)
		expect(ZERO_ATTEMPTS.failures).toBe(0)
		expect(LOCK_MS).toBe(300_000)
	})
})
