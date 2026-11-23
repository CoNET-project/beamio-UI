/**
 * 助记词版本化密文 v3（规格：the spec 定稿节第 2、4、5 节；向量：mnemonic-cipher-format.v3.json，MCF3-01 至 MCF3-11）。
 *
 * - 信封：{ v: 3, mode: 'passcode', eoa, kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt, iv, alg: 'AES-256-GCM', ct }。
 * - 密钥：Argon2id(六位口令 UTF-8 字节, 随机 16 字节盐) 得 32 字节，导入为不可导出的 AES-GCM-256 密钥；
 *   派生结果不写入信封，也不写入任何存储。
 * - AAD：`beamio-mnemonic-cipher-v3|argon2id-aes256gcm|<eoa 小写>`。
 * - 判定顺序（写死）：1 版本与参数 → 2 用信封 eoa 组 AAD 解密（GCM 失败 → unlock_failed）
 *   → 3 解密后由助记词派生地址，与信封 eoa 不符 → verify_failed。
 * - 解密不套口令设置规则；设置与更改口令只接受固定六位 ASCII 数字（MCF3-07 → bad_request）。
 * - 本模块是纯函数：不读写任何存储，不记录日志。旧格式（v=1、无 v、PBKDF2、mode=device）只作拒绝，
 *   返回 verify_failed，输入对象不被修改。
 *
 * 限制：六位数字加 Argon2id 只提高离线猜测成本，不能消除离线枚举。冷却由 PWA 负责（passcodeBackoff.ts）。
 */
import { Wallet } from 'ethers'
import { b64dec, b64enc, randomBytes, utf8, utf8Decode } from './walletWrap'

export const MCF3_VERSION = 3
export const MCF3_MODE = 'passcode' as const
export const MCF3_ALG = 'AES-256-GCM' as const
export const MCF3_KDF = 'argon2id/m=32768/t=3/p=1/dkLen=32' as const
export const MCF3_ARGON2 = { m: 32768, t: 3, p: 1, dkLen: 32 } as const
export const MCF3_SALT_BYTES = 16
export const MCF3_IV_BYTES = 12
const MCF3_AAD_PREFIX = 'beamio-mnemonic-cipher-v3|argon2id-aes256gcm|'

/** 应答码闭集中与本模块相关的部分（规格第 5 节）。 */
export type MnemonicCipherCode = 'ok' | 'unlock_failed' | 'verify_failed' | 'bad_request' | 'passcode_not_provided'

export interface MnemonicCipherEnvelopeV3 {
	v: 3
	mode: 'passcode'
	eoa: string
	kdf: typeof MCF3_KDF
	/** 标准 base64，16 字节 */
	salt: string
	/** 标准 base64，12 字节 */
	iv: string
	alg: typeof MCF3_ALG
	/** 标准 base64，密文 ‖ 16 字节 tag */
	ct: string
}

export type OpenMnemonicResult =
	| { code: 'ok'; phrase: string; eoa: string }
	| { code: Exclude<MnemonicCipherCode, 'ok'> }

/**
 * 存储层与口令状态的映射（v291 与 SRP v2 904fcf2c…e64，2026-11-22）：
 * - 真实读取故障 → record_unreadable（不是确认缺失，保数据）；
 * - 真实写入故障 → write_failed（仅表示真实写入故障）；
 * - 有口令账户未提供口令 → not_ready + passcode_not_provided（不计确认缺失，不进 onboarding，不出错误屏，不计重试）。
 * 不新增 unknown 码：未知状态沿用 not_ready（带原因）或 migrating，PWA 一律按非确认缺失、保数据处理。
 */
export type StorageOutcomeCode = 'record_unreadable' | 'write_failed'
export type NotReadyOutcome = { status: 'not_ready'; code: 'passcode_not_provided' }

export const storageFailureCode = (op: 'read' | 'write'): StorageOutcomeCode => (op === 'read' ? 'record_unreadable' : 'write_failed')

export const passcodeLockedOutcome = (): NotReadyOutcome => ({ status: 'not_ready', code: 'passcode_not_provided' })

export const isSixDigitPasscode =(p: unknown): p is string => typeof p === 'string' && /^[0-9]{6}$/.test(p)

export const mcf3Aad = (eoa: string): Uint8Array => utf8(`${MCF3_AAD_PREFIX}${eoa.toLowerCase()}`)

const EOA_RE = /^0x[0-9a-fA-F]{40}$/

const subtle = (): SubtleCrypto => {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c?.subtle) throw new Error('no_webcrypto')
	return c.subtle
}

/** Argon2id 派生函数的形状（与 argon2WorkerBridge.argon2idAsync 相同）。 */
export type MnemonicKdf = (password: Uint8Array, salt: Uint8Array, opts: typeof MCF3_ARGON2) => Promise<Uint8Array>

let injectedKdf: MnemonicKdf | null = null

/**
 * 测试注入点。生产路径不调用本函数：未注入时经动态导入使用 argon2WorkerBridge.argon2idAsync（Worker 执行，
 * Worker 不可用时由桥回退到主线程）。Jest 无法解析桥模块中的 import.meta，因此测试注入 @noble/hashes 同步派生。
 */
export function setMnemonicKdfForTest(f: MnemonicKdf | null): void {
	injectedKdf = f
}

async function resolveKdf(): Promise<MnemonicKdf> {
	if (injectedKdf) return injectedKdf
	const bridge = await import('../argon2WorkerBridge')
	return bridge.argon2idAsync
}

/**
 * 派生 AES 密钥。派生输出与口令字节在导入后清零。
 */
async function deriveAesKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
	const pw = utf8(passcode)
	let raw: Uint8Array | null = null
	try {
		const kdf = await resolveKdf()
		raw = await kdf(pw, salt, MCF3_ARGON2)
		return await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
	} finally {
		raw?.fill(0)
		pw.fill(0)
	}
}

/**
 * 用已派生的 AES 密钥加密（unit f3 入口，2026-11-22）。口令派生由调用方完成，同一把密钥可服务整条记录。
 * 盐与 IV 由调用方给出（盐 16 字节、IV 12 字节）；IV 必须每次随机，调用方负责。
 */
export async function sealMnemonicV3WithKey(
	key: CryptoKey,
	salt: Uint8Array,
	phrase: string,
	eoa: string,
	iv: Uint8Array,
): Promise<MnemonicCipherEnvelopeV3 | { code: 'bad_request' }> {
	if (!EOA_RE.test(eoa)) return { code: 'bad_request' }
	if (salt.length !== MCF3_SALT_BYTES || iv.length !== MCF3_IV_BYTES) return { code: 'bad_request' }
	const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: mcf3Aad(eoa), tagLength: 128 }, key, utf8(phrase)))
	return {
		v: 3,
		mode: MCF3_MODE,
		eoa: eoa.toLowerCase(),
		kdf: MCF3_KDF,
		salt: b64enc(salt),
		iv: b64enc(iv),
		alg: MCF3_ALG,
		ct: b64enc(ct),
	}
}

/**
 * 加密（设置与更改口令）。口令必须为固定六位 ASCII 数字，否则 bad_request 且不做任何加密。
 * 盐与 IV 每次随机生成；派生密钥只在本函数内存活。
 */
export async function sealMnemonicV3(
	phrase: string,
	eoa: string,
	passcode: string,
	fixedRandom?: { salt: Uint8Array; iv: Uint8Array },
): Promise<MnemonicCipherEnvelopeV3 | { code: 'bad_request' }> {
	if (!isSixDigitPasscode(passcode)) return { code: 'bad_request' }
	if (!EOA_RE.test(eoa)) return { code: 'bad_request' }
	const salt = fixedRandom?.salt ?? randomBytes(MCF3_SALT_BYTES)
	const iv = fixedRandom?.iv ?? randomBytes(MCF3_IV_BYTES)
	const key = await deriveAesKey(passcode, salt)
	return sealMnemonicV3WithKey(key, salt, phrase, eoa, iv)
}

type ParsedV3 = { eoa: string; salt: Uint8Array; iv: Uint8Array; ct: Uint8Array } | { code: 'verify_failed' }

/** 版本与参数、字段形状（解密前）。不符即 verify_failed；旧 v=1、无 v、PBKDF2、mode=device 均在此拒绝。不修改输入。 */
function parseEnvelopeV3(raw: unknown): ParsedV3 {
	const r = raw as Partial<Record<keyof MnemonicCipherEnvelopeV3, unknown>> | null
	if (!r || typeof r !== 'object') return { code: 'verify_failed' }
	if (r.v !== MCF3_VERSION || r.mode !== MCF3_MODE || r.kdf !== MCF3_KDF || r.alg !== MCF3_ALG) return { code: 'verify_failed' }
	if (typeof r.eoa !== 'string' || !EOA_RE.test(r.eoa)) return { code: 'verify_failed' }
	if (typeof r.salt !== 'string' || typeof r.iv !== 'string' || typeof r.ct !== 'string') return { code: 'verify_failed' }
	let salt: Uint8Array
	let iv: Uint8Array
	let ct: Uint8Array
	try {
		salt = b64dec(r.salt)
		iv = b64dec(r.iv)
		ct = b64dec(r.ct)
	} catch {
		return { code: 'verify_failed' }
	}
	if (salt.length !== MCF3_SALT_BYTES || iv.length !== MCF3_IV_BYTES || ct.length < 16) return { code: 'verify_failed' }
	return { eoa: r.eoa, salt, iv, ct }
}

/** GCM with the envelope eoa in the AAD, then the address check (step 3). */
async function openParsedWithKey(key: CryptoKey, p: Exclude<ParsedV3, { code: 'verify_failed' }>): Promise<OpenMnemonicResult> {
	// 2. 用信封 eoa 组 AAD 解密（口令错、篡改、AAD 不符都是 GCM 失败）
	let plain: Uint8Array
	try {
		plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: p.iv, additionalData: mcf3Aad(p.eoa), tagLength: 128 }, key, p.ct))
	} catch {
		return { code: 'unlock_failed' }
	}
	// 3. 解密后由助记词派生地址，与信封 eoa 比较
	const phrase = utf8Decode(plain)
	plain.fill(0)
	let derived: string
	try {
		derived = Wallet.fromPhrase(phrase).address.toLowerCase()
	} catch {
		return { code: 'verify_failed' }
	}
	if (derived !== p.eoa.toLowerCase()) return { code: 'verify_failed' }
	return { code: 'ok', phrase, eoa: derived }
}

/**
 * 解密（解锁页或 SDK 桥）。输入为原始记录（未知形状），不修改它。
 * passcode 为 undefined 时直接返回 passcode_not_provided，不做任何解密尝试。
 */
export async function openMnemonicV3(raw: unknown, passcode: string | undefined): Promise<OpenMnemonicResult> {
	if (passcode === undefined) return { code: 'passcode_not_provided' }
	const p = parseEnvelopeV3(raw)
	if ('code' in p) return { code: p.code }
	// 派生失败（例如无 WebCrypto）不是口令错误，向上抛出，由调用方按未知处理
	const key = await deriveAesKey(passcode, p.salt)
	return openParsedWithKey(key, p)
}

/** 用已派生的 AES 密钥解密（unit f3 入口，2026-11-22）。同一判定顺序；密钥与盐由调用方保证一致。 */
export async function openMnemonicV3WithKey(key: CryptoKey, raw: unknown): Promise<OpenMnemonicResult> {
	const p = parseEnvelopeV3(raw)
	if ('code' in p) return { code: p.code }
	return openParsedWithKey(key, p)
}
