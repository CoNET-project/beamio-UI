/**
 * @jest-environment node
 *
 * Unit f3 follow-up (decision): the wallet wrap of privateKeyArmor / pgpPrivateKeyArmored binds the field name and the
 * account (lower-case eoa) in the AAD, and every seal uses a fresh random IV. SYNTHETIC values only.
 * The KDF is the worker bridge in production; the Jest double here is a fast Argon2id stand-in through the injection point (the bridge cannot load under Jest).
 */
import { argon2idAsync } from '@noble/hashes/argon2'
import { setPasscodeKdfForTest, type PasscodeKdf } from './walletWrap'
import { setMnemonicKdfForTest } from './mnemonicCipherV3'
import { webcrypto } from 'crypto'
import { newSalt, passcodeWrapKey, unwrapField, wrapField, type WrapRecord } from './walletWrap'
import { openWalletForStartup, resetWalletSession, setWalletPasscode, unlockWalletPasscode, type WalletMeta, type WalletStores } from './walletVault'
import { memoryAtomicKeyValueDb, passcodeAttemptRecordStore } from './passcodeWrapStore'

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

const A = '0x9858effd232b4033e47d90003d41ec34ecaeda94' // the account of the public BIP-39 test phrase below
const B = '0x' + '33'.repeat(20)
const KEY_A = '0x' + '11'.repeat(32)
const KEY_B = '0x' + '44'.repeat(32)
const PASS = '395784'

describe('AAD binds field and account', () => {
	it('opens only with the same field and the same account; a moved record fails (decrypt_failed)', async () => {
		const salt = newSalt()
		const key = await passcodeWrapKey(PASS, salt)
		const rec: WrapRecord = await wrapField(key, KEY_A, 'privateKeyArmor', A, salt)
		expect(await unwrapField(key, rec, 'privateKeyArmor', A)).toBe(KEY_A)
		// same record, another field of the same account
		await expect(unwrapField(key, rec, 'pgpPrivateKeyArmored', A)).rejects.toThrow('decrypt_failed')
		// same record, the same field of another account
		await expect(unwrapField(key, rec, 'privateKeyArmor', B)).rejects.toThrow('decrypt_failed')
	}, 60_000)

	it('a privateKeyArmor record moved between two accounts in the stored wallet fails to open once unlocked', async () => {
		resetWalletSession()
		let initJson = JSON.stringify({ profiles: [{ keyID: A, privateKeyArmor: KEY_A }, { keyID: B, privateKeyArmor: KEY_B }], mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })
		const attemptDb = memoryAtomicKeyValueDb()
		const meta: WalletMeta = { failures: 0, nextAt: 0 }
		const stores: WalletStores = {
			readInit: async () => JSON.parse(initJson),
			writeInit: async (d) => {
				initJson = JSON.stringify(d)
			},
			readMeta: async () => meta,
			writeMeta: async () => undefined,
			attemptsFor: (e: string) => passcodeAttemptRecordStore(attemptDb, e),
		}
		expect((await setWalletPasscode(stores, PASS, JSON.parse(initJson))).ok).toBe(true)
		expect((await unlockWalletPasscode(stores, PASS, 1_800_000_000_000)).ok).toBe(true)
		// move account A's key record into account B's slot
		const stored = JSON.parse(initJson) as { profiles: Array<{ keyID: string; privateKeyArmor: unknown }> }
		const swapped = { ...stored, profiles: [{ ...stored.profiles[0], privateKeyArmor: stored.profiles[1].privateKeyArmor }, stored.profiles[1]] }
		initJson = JSON.stringify(swapped)
		const res = await openWalletForStartup(stores, JSON.parse(initJson))
		expect(res).toEqual({ status: 'error', reason: 'decrypt_failed' })
	}, 120_000)
})

describe('a fresh random IV on every seal', () => {
	it('40 seals of the same plaintext under one key give 40 distinct IVs; the three fields share the key, not the IV', async () => {
		const salt = newSalt()
		const key = await passcodeWrapKey(PASS, salt)
		const ivs = new Set<string>()
		for (let i = 0; i < 40; i++) {
			const rec = await wrapField(key, KEY_A, 'privateKeyArmor', A, salt)
			ivs.add(rec.iv)
		}
		for (const field of ['recoveryWords', 'privateKeyArmor', 'pgpPrivateKeyArmored']) {
			ivs.add((await wrapField(key, 'same', field, A, salt)).iv)
		}
		expect(ivs.size).toBe(43)
	}, 60_000)
})
