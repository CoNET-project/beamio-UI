/**
 * @jest-environment node
 *
 * 助记词 v3 密文测试（the spec 定稿节第 11 节）。向量读取自本目录的 __fixtures__（合成测试值），不写回。
 * 所有助记词与口令均为合成值（向量文件内的 fog spot ... reflect 与口令 482913）。
 */
import { existsSync, readFileSync } from 'fs'
import { argon2id } from '@noble/hashes/argon2.js'
import {
	openMnemonicV3,
	sealMnemonicV3,
	isSixDigitPasscode,
	MCF3_KDF,
	storageFailureCode,
	passcodeLockedOutcome,
	setMnemonicKdfForTest,
} from './mnemonicCipherV3'

// Argon2id (m=32 MiB, t=3) measured inside Jest at about 15.5 s per derive (plain Node about 0.6 s; the
// Jest transform environment is the cause). Per-derive budget: 30 s. Tests that run three derives get 60 s.
jest.setTimeout(30_000)

beforeAll(() => {
	// 测试用同步 noble 派生（生产路径走 Worker 桥，见 setMnemonicKdfForTest 注释）
	setMnemonicKdfForTest(async (pw, salt, o) => argon2id(pw, salt, { m: o.m, t: o.t, p: o.p, dkLen: o.dkLen }))
	const { webcrypto } = require('crypto')
	if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
		Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
	}
})

const VEC_DIR = `${__dirname}/__fixtures__`
const V3 = JSON.parse(readFileSync(`${VEC_DIR}/mnemonic-cipher-format.v3.json`, 'utf8'))
const MCF305 = JSON.parse(readFileSync(`${VEC_DIR}/mnemonic-cipher-format.v3-mcf305-explicit.json`, 'utf8'))
// optional cross-implementation file produced by another build (path in the environment); the cross cases are skipped when it is absent
const ANDROID_FILE = process.env.MCF3_ANDROID_FILE ?? ''

const PHRASE = V3.syntheticInputs.phrase as string
const EOA = V3.syntheticInputs.eoa as string
const PASSCODE = V3.syntheticInputs.sixDigitPasscode as string
const CT_OK: string = V3.ctFixtures.ctOK
const CT_OTHER: string = V3.ctFixtures.ctOtherAAD
const CT_TAMPERED: string = V3.ctFixtures.tampered
const OTHER_EOA = '0x2222222222222222222222222222222222222222'

const envelope = (over: Record<string, unknown> = {}, ct: string = CT_OK) => ({
	v: 3,
	mode: 'passcode',
	eoa: EOA,
	kdf: MCF3_KDF,
	salt: V3.syntheticInputs.saltB64,
	iv: V3.syntheticInputs.ivB64,
	alg: 'AES-256-GCM',
	ct,
	...over,
})

const snapshot = (x: unknown) => JSON.stringify(x)

describe('MCF3 向量（mnemonic-cipher-format.v3.json）', () => {
	it('MCF3-01 正确口令解开，派生地址与信封 eoa 相符', async () => {
		const raw = V3.cases[0].envelope
		const before = snapshot(raw)
		const r = await openMnemonicV3(raw, PASSCODE)
		expect(r).toEqual({ code: 'ok', phrase: PHRASE, eoa: EOA })
		expect(snapshot(raw)).toBe(before)
	})

	it('MCF3-02 错误六位口令 → unlock_failed（数据保留）', async () => {
		const raw = V3.cases[1].envelope
		const before = snapshot(raw)
		expect(await openMnemonicV3(raw, '000000')).toEqual({ code: 'unlock_failed' })
		expect(snapshot(raw)).toBe(before)
	})

	it('MCF3-03 密文被篡改 → unlock_failed', async () => {
		expect(await openMnemonicV3(V3.cases[2].envelope, PASSCODE)).toEqual({ code: 'unlock_failed' })
	})

	it('MCF3-04 版本不是 3 → verify_failed（解密前拒绝）', async () => {
		expect(await openMnemonicV3(V3.cases[3].envelope, PASSCODE)).toEqual({ code: 'verify_failed' })
	})

	it('MCF3-05 ctOtherAAD 配 0x2222 信封 → verify_failed（解密成功，地址不符）', async () => {
		expect(await openMnemonicV3(V3.cases[4].envelope, PASSCODE)).toEqual({ code: 'verify_failed' })
	})

	it('MCF3-05b ctOK 配 0x2222 信封 → unlock_failed（AAD 不符）', async () => {
		const r = await openMnemonicV3(envelope({ eoa: OTHER_EOA }, CT_OK), PASSCODE)
		expect(r).toEqual({ code: 'unlock_failed' })
	})

	it('MCF3-06 AAD 绑定 eoa：ctOtherAAD 配真实信封 → unlock_failed', async () => {
		expect(await openMnemonicV3(V3.cases[5].envelope, PASSCODE)).toEqual({ code: 'unlock_failed' })
	})

	it('MCF3-07 非六位口令在设置时 → bad_request（解密路径不套此规则）', async () => {
		expect(isSixDigitPasscode(V3.cases[6].passcode)).toBe(false)
		expect(await sealMnemonicV3(PHRASE, EOA, V3.cases[6].passcode)).toEqual({ code: 'bad_request' })
		expect(isSixDigitPasscode('482913')).toBe(true)
		expect(isSixDigitPasscode('4829130')).toBe(false)
		expect(isSixDigitPasscode('48291a')).toBe(false)
	})

	it('MCF3-11 未提供口令 → passcode_not_provided（不做解密尝试）', async () => {
		expect(await openMnemonicV3(V3.cases[0].envelope, undefined)).toEqual({ code: 'passcode_not_provided' })
	})

	it('MCF3-01 常量：信封 kdf 与参数与规格一致', () => {
		expect(MCF3_KDF).toBe('argon2id/m=32768/t=3/p=1/dkLen=32')
		expect(V3.syntheticInputs.argon2).toEqual({ m: 32768, t: 3, p: 1, dkLen: 32 })
	})
})

describe('MCF305 显式构造（mnemonic-cipher-format.v3-mcf305-explicit.json）', () => {
	it('MCF3-05 显式构造 → verify_failed', async () => {
		const c = MCF305.construction['MCF3-05-verify_failed']
		expect(c.ct).toBe(CT_OTHER)
		expect(await openMnemonicV3(envelope({ eoa: c.envelopeEoa }, c.ct), PASSCODE)).toEqual({ code: 'verify_failed' })
	})

	it('MCF3-05b 显式构造 → unlock_failed', async () => {
		const c = MCF305.construction['MCF3-05b-unlock_failed-envelope-eoa-edited-after-encrypt']
		expect(await openMnemonicV3(envelope({ eoa: c.envelopeEoa }, c.ct), PASSCODE)).toEqual({ code: 'unlock_failed' })
	})

	it('MCF3-06 显式参考 → unlock_failed', async () => {
		const c = MCF305.construction['MCF3-06-reference']
		expect(await openMnemonicV3(envelope({ eoa: c.envelopeEoa }, c.ct), PASSCODE)).toEqual({ code: 'unlock_failed' })
	})
})

describe('加密与往返', () => {
	it('seal 后 open 往返一致，IV 与盐随机（两次密文不同）', async () => {
		const a = await sealMnemonicV3(PHRASE, EOA, '482913')
		const b = await sealMnemonicV3(PHRASE, EOA, '482913')
		if ('code' in a || 'code' in b) throw new Error('seal failed')
		expect(a.salt).not.toBe(b.salt)
		expect(a.iv).not.toBe(b.iv)
		expect(a.ct).not.toBe(b.ct)
		expect(await openMnemonicV3(a, '482913')).toEqual({ code: 'ok', phrase: PHRASE, eoa: EOA })
	}, 60_000) // three derives (two seals, one open) at about 15.5 s each in Jest

	it('seal 的信封不含派生密钥字段', async () => {
		const a = await sealMnemonicV3(PHRASE, EOA, '482913')
		if ('code' in a) throw new Error('seal failed')
		expect(Object.keys(a).sort()).toEqual(['alg', 'ct', 'eoa', 'iv', 'kdf', 'mode', 'salt', 'v'])
	})
})

describe('存储与口令状态映射（v291 与 SRP v2）', () => {
	it('MCF3-10 真实读取故障 → record_unreadable（保数据）', () => {
		expect(storageFailureCode('read')).toBe('record_unreadable')
	})

	it('写入真实故障 → write_failed', () => {
		expect(storageFailureCode('write')).toBe('write_failed')
	})

	it('MCF3-11 有口令未提供 → not_ready + passcode_not_provided，且不是确认缺失', () => {
		const o = passcodeLockedOutcome()
		expect(o).toEqual({ status: 'not_ready', code: 'passcode_not_provided' })
		expect(o.code).not.toBe('confirmed_missing')
	})
})

describe('旧格式只作拒绝（迁移）', () => {
	const legacyPbkdf2 = {
		v: 1,
		mode: 'passcode',
		eoa: EOA,
		kdf: 'PBKDF2-HMAC-SHA256/600000/32',
		salt: V3.syntheticInputs.saltB64,
		iv: V3.syntheticInputs.ivB64,
		ct: CT_OK,
	}
	const noVersionPbkdf2 = { ...legacyPbkdf2, v: undefined }
	const deviceMode = { v: 1, mode: 'device', eoa: EOA, kdf: null, salt: null, iv: V3.syntheticInputs.ivB64, ct: CT_OK }

	it.each([
		['v=1 PBKDF2 口令格式', legacyPbkdf2],
		['无 v 的 PBKDF2 记录', noVersionPbkdf2],
		['mode=device 旧设备保护密钥', deviceMode],
	])('%s → verify_failed，且原字节保留', async (_name, raw) => {
		const before = snapshot(raw)
		const r = await openMnemonicV3(raw, '482913')
		expect(r).toEqual({ code: 'verify_failed' })
		expect(snapshot(raw)).toBe(before)
	})

	it('非对象输入 → verify_failed', async () => {
		expect(await openMnemonicV3(null, '482913')).toEqual({ code: 'verify_failed' })
		expect(await openMnemonicV3('oops', '482913')).toEqual({ code: 'verify_failed' })
	})
})

const describeCross = ANDROID_FILE !== '' && existsSync(ANDROID_FILE) ? describe : describe.skip
describeCross('互解：Android 生成的 v3 密文（只读）', () => {
	it('候选代码解开 Android 密文 → 期望短语与派生地址', async () => {
		const lines = readFileSync(ANDROID_FILE, 'utf8').split('\n')
		const jsonLine = lines.find((l) => l.startsWith('{'))
		if (!jsonLine) throw new Error('android envelope line missing')
		const env = JSON.parse(jsonLine)
		const r = await openMnemonicV3(env, '482913')
		expect(r).toEqual({
			code: 'ok',
			phrase: 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect',
			eoa: '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f',
		})
	})
})
