/**
 * @jest-environment node
 */
/**
 * f2 (startup) use of f1's v3 module: MCF3-01 to MCF3-06 with the real derivation (ethers) and the real Argon2id parameters, on the
 * SYNTHETIC vector (mnemonic-cipher-format.v3.json). The KDF is injected with @noble/hashes (same algorithm; the Worker bridge cannot
 * be parsed by this Jest setup).
 */
import { webcrypto } from 'crypto'
import { argon2id } from '@noble/hashes/argon2.js'
import { openMnemonicV3, setMnemonicKdfForTest } from './mnemonicCipherV3'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
const PASSCODE = '482913'
const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const PHRASE = 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect'
const SALT = 'AAECAwQFBgcICQoLDA0ODw=='
const IV = 'AAECAwQFBgcICQoL'
const CT_OK = 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0='
const CT_OTHER_AAD = 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816SNVFJ919dazVSo6aqSKTno='
const CT_TAMPERED = 'dyJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0='
const OTHER = '0x2222222222222222222222222222222222222222'
const env = (ct: string, eoa = EOA, v: number = 3) => ({ v, mode: 'passcode', eoa, kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: SALT, iv: IV, alg: 'AES-256-GCM', ct })

jest.setTimeout(120_000)
beforeAll(() => {
	setMnemonicKdfForTest(async (pw, salt, o) => Uint8Array.from(argon2id(pw, salt, { m: o.m, t: o.t, p: o.p, dkLen: o.dkLen })))
})
afterAll(() => setMnemonicKdfForTest(null))

describe('MCF3 vectors through f1 module (startup use)', () => {
	it('MCF3-01 correct passcode: ok, phrase and derived EOA', async () => {
		expect(await openMnemonicV3(env(CT_OK), PASSCODE)).toEqual({ code: 'ok', phrase: PHRASE, eoa: EOA })
	})
	it('MCF3-02 wrong passcode: unlock_failed', async () => {
		expect(await openMnemonicV3(env(CT_OK), '111111')).toEqual({ code: 'unlock_failed' })
	})
	it('MCF3-03 tampered: unlock_failed', async () => {
		expect(await openMnemonicV3(env(CT_TAMPERED), PASSCODE)).toEqual({ code: 'unlock_failed' })
	})
	it('MCF3-04 version 2: verify_failed before decryption', async () => {
		expect(await openMnemonicV3(env(CT_OK, EOA, 2), PASSCODE)).toEqual({ code: 'verify_failed' })
	})
	it('MCF3-05 derived EOA differs from the envelope: verify_failed', async () => {
		expect(await openMnemonicV3(env(CT_OTHER_AAD, OTHER), PASSCODE)).toEqual({ code: 'verify_failed' })
	})
	it('MCF3-06 AAD bound to the EOA: unlock_failed', async () => {
		expect(await openMnemonicV3(env(CT_OTHER_AAD, EOA), PASSCODE)).toEqual({ code: 'unlock_failed' })
	})
})
