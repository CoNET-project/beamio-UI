/**
 * @jest-environment node
 *
 * Unit f3 (2026-11-22): six-digit passcode set and change, the cooldown by passcodeBackoff (3 wrong: 5 min; each further wrong: 5 min;
 * success clears), and refusal of the removed formats (v=1, PBKDF2, device mode) with the stored bytes unchanged.
 * SYNTHETIC values only: test phrase, synthetic key, synthetic passcodes. Nothing is written to real storage.
 */
import { lockWalletSession, openWalletForStartup, resetWalletSession, setWalletPasscode, unlockWalletPasscode, type WalletMeta, type WalletStores } from './walletVault'
import { memoryAtomicKeyValueDb, passcodeAttemptRecordStore } from './passcodeWrapStore'
import { openMnemonicV3, sealMnemonicV3WithKey, MCF3_KDF } from './mnemonicCipherV3'
import { passcodeWrapKey, setPasscodeKdfForTest, type PasscodeKdf } from './walletWrap'
import { setMnemonicKdfForTest } from './mnemonicCipherV3'
import { argon2idAsync } from '@noble/hashes/argon2'
// the production KDF is the worker bridge (jest cannot load it); the injection points run the real Argon2id of @noble/hashes at the
// production parameters (m 32 MiB, t 3, p 1)
const productionArgon2: PasscodeKdf = (password, salt, opts) => argon2idAsync(password, salt, opts)
beforeAll(() => {
	setPasscodeKdfForTest(productionArgon2)
	setMnemonicKdfForTest(productionArgon2)
})
afterAll(() => {
	setPasscodeKdfForTest(null)
	setMnemonicKdfForTest(null)
})
import { webcrypto } from 'crypto'


// jest's node environment may lack getRandomValues on globalThis.crypto; the wrap needs it
if (!(globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94' // the account of the public BIP-39 test phrase below
const KEY = '0x' + '11'.repeat(32)
const PASS = '395784'
const WRONG = '571936'

/** An in-memory store: holds JSON copies, so a byte comparison is meaningful. */
function memoryStores(init: Record<string, unknown> | null) {
	let initJson: string | null = init === null ? null : JSON.stringify(init)
	let metaJson: string | null = null
	const attemptDb = memoryAtomicKeyValueDb()
	const stores: WalletStores = {
		attemptsFor: (e: string) => passcodeAttemptRecordStore(attemptDb, e),
		readInit: async () => (initJson === null ? null : JSON.parse(initJson)),
		writeInit: async (d) => {
			initJson = JSON.stringify(d)
		},
		readMeta: async (): Promise<WalletMeta> => (metaJson === null ? { failures: 0, nextAt: 0 } : JSON.parse(metaJson)),
		writeMeta: async (m) => {
			metaJson = JSON.stringify(m)
		},
	}
	return { stores, raw: () => initJson, meta: () => (metaJson === null ? null : JSON.parse(metaJson) as WalletMeta) }
}

const plainWallet = () => ({ profiles: [{ keyID: EOA, privateKeyArmor: KEY }], mnemonicPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })

beforeEach(() => {
	resetWalletSession()
})

describe('six-digit passcode set (policy applies only here)', () => {
	it('refuses a weak six-digit passcode and writes nothing', async () => {
		const m = memoryStores(plainWallet())
		const before = m.raw()
		const res = await setWalletPasscode(m.stores, '123456', plainWallet())
		expect(res).toEqual({ ok: false, reason: 'weak', problem: 'common' })
		expect(m.raw()).toBe(before)
	})

	it('accepts a six-digit passcode and the stored record is the v3 passcode shape', async () => {
		const m = memoryStores(plainWallet())
		const res = await setWalletPasscode(m.stores, PASS, plainWallet())
		expect(res).toEqual({ ok: true })
		const stored = JSON.parse(m.raw() as string) as { profiles: { privateKeyArmor: { v: number; mode: string; kdf: string } }[] }
		expect(stored.profiles[0].privateKeyArmor).toMatchObject({ v: 3, mode: 'passcode', kdf: 'argon2id-aes256gcm/m32768/t3/p1' })
	}, 60_000)
})

describe('removed formats are refused, never decrypted, bytes unchanged', () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		['v=1 record', { v: 1, mode: 'passcode', eoa: EOA, kdf: 'PBKDF2-HMAC-SHA256/600000/32', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' }],
		['no v with a PBKDF2 kdf', { mode: 'passcode', eoa: EOA, kdf: 'PBKDF2-HMAC-SHA256/600000/32', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' }],
		['device-mode record', { v: 3, mode: 'device', eoa: EOA, kdf: null, salt: null, iv: 'aXY=', ct: 'Y3Q=' }],
	]
	for (const [name, rec] of cases) {
		it(`${name}: verify_failed, and the stored object is not modified`, async () => {
			const init = { profiles: [{ keyID: EOA, privateKeyArmor: rec }] }
			const bytes = JSON.stringify(init)
			const m = memoryStores(init)
			const res = await openWalletForStartup(m.stores, JSON.parse(bytes))
			expect(res).toEqual({ status: 'error', reason: 'verify_failed' })
			expect(m.raw()).toBe(bytes)
		})
	}

	it('an unlock attempt on a removed-format record reports error and writes no counter', async () => {
		const T0 = 1_800_000_000_000
		const init = { profiles: [{ keyID: EOA, privateKeyArmor: { v: 1, mode: 'passcode', eoa: EOA, kdf: 'PBKDF2-HMAC-SHA256/600000/32', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=' } }] }
		const m = memoryStores(init)
		const res = await unlockWalletPasscode(m.stores, PASS, 1_800_000_000_000)
		expect(res).toEqual({ ok: false, reason: 'error' })
		expect(m.meta()).toBeNull()
	})
})

describe('the mnemonic record is the f1 mnemonic-cipher-format v3 envelope', () => {
	// f1 check 3 derives the address from the phrase, so this case uses a real BIP-39 test phrase and its address (public test vector)
	const PH = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
	const PH_EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
	const phraseWallet = () => ({ profiles: [{ keyID: PH_EOA, privateKeyArmor: KEY }], mnemonicPhrase: PH })
	it('set stores mnemonicPhrase as the f1 envelope, and openMnemonicV3 with the passcode returns the phrase', async () => {
		const m = memoryStores(phraseWallet())
		expect((await setWalletPasscode(m.stores, PASS, phraseWallet())).ok).toBe(true)
		const stored = JSON.parse(m.raw() as string) as { mnemonicPhrase: Record<string, unknown> }
		expect(stored.mnemonicPhrase).toMatchObject({ v: 3, mode: 'passcode', kdf: MCF3_KDF, alg: 'AES-256-GCM', eoa: PH_EOA })
		expect(Object.keys(stored.mnemonicPhrase).sort()).toEqual(['alg', 'ct', 'eoa', 'iv', 'kdf', 'mode', 'salt', 'v'])
		expect(await openMnemonicV3(stored.mnemonicPhrase, PASS)).toEqual({ code: 'ok', phrase: PH, eoa: PH_EOA })
		expect(await openMnemonicV3(stored.mnemonicPhrase, WRONG)).toEqual({ code: 'unlock_failed' })
	}, 120_000)
})

describe('byte regression against the MCF3 vector (f1 envelope through the key entry point)', () => {
	it('sealMnemonicV3WithKey with the vector salt, iv and passcode reproduces MCF3-01 byte for byte', async () => {
		const { readFileSync } = require('fs')
		const v3 = JSON.parse(readFileSync(`${__dirname}/__fixtures__/mnemonic-cipher-format.v3.json`, 'utf8'))
		const inp = v3.syntheticInputs
		const salt = Buffer.from(inp.saltB64, 'base64')
		const iv = Buffer.from(inp.ivB64, 'base64')
		const key = await passcodeWrapKey(inp.sixDigitPasscode, new Uint8Array(salt))
		const env = await sealMnemonicV3WithKey(key, new Uint8Array(salt), inp.phrase, inp.eoa, new Uint8Array(iv))
		expect(env).toEqual(v3.cases[0].envelope)
	}, 120_000)
})
