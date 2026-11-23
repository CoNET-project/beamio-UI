/**
 * @jest-environment node
 */
/**
 * Setting the passcode with the real f1 v3 seal and open (Argon2id with the test KDF injection, AES-256-GCM). Order, the in-memory check
 * before the write, the first sync with the passcode, completion only on ok with decrypted:true, and the no-passcode background sync after.
 */
import { webcrypto } from 'crypto'
import { argon2id } from '@noble/hashes/argon2.js'
import { sealMnemonicV3, openMnemonicV3, setMnemonicKdfForTest } from './passcode/mnemonicCipherV3'
import { setPasscodeThenSync, type SetPasscodeSteps } from './passcodeSetSync'
import { createShellMnemonicSync } from './shellMnemonicSync'

if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
jest.setTimeout(120_000)
beforeAll(() => setMnemonicKdfForTest(async (pw, salt, o) => Uint8Array.from(argon2id(pw, salt, { m: o.m, t: o.t, p: o.p, dkLen: o.dkLen }))))
afterAll(() => setMnemonicKdfForTest(null))

const PHRASE = 'fog spot notable regret pizza coffee harvest ensure fog spot notable reflect'
const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const PASS = '482913'

function realSteps(over: Partial<SetPasscodeSteps> = {}) {
	const calls: string[] = []
	const steps: SetPasscodeSteps = {
		seal: async (phrase, eoa, pc) => {
			calls.push('seal')
			const r = await sealMnemonicV3(phrase, eoa, pc)
			return 'code' in r ? null : (r as unknown as Record<string, unknown>)
		},
		openInMemory: async (env, pc) => {
			calls.push('open')
			return (await openMnemonicV3(env, pc)) as { code: string; phrase?: string; eoa?: string }
		},
		writeRecord: async () => {
			calls.push('write')
			return true
		},
		firstSyncWithPasscode: async () => {
			calls.push('sync')
			return 'ok'
		},
		...over,
	}
	return { steps, calls }
}

describe('setting the passcode: in-memory check before the IDB write; the first sync carries the passcode', () => {
	it('S1 the order is seal, open in memory and check, then the write, then the first sync; complete on ok', async () => {
		const { steps, calls } = realSteps()
		expect(await setPasscodeThenSync({ phrase: PHRASE, eoa: EOA, passcode: PASS }, steps)).toBe('complete')
		expect(calls).toEqual(['seal', 'open', 'write', 'sync'])
	})

	it('S2 an address that does not match on the in-memory check: no write, no sync', async () => {
		const { steps, calls } = realSteps({
			openInMemory: async () => {
				calls.push('open')
				return { code: 'ok', phrase: PHRASE, eoa: '0x' + '1'.repeat(40) }
			},
		})
		expect(await setPasscodeThenSync({ phrase: PHRASE, eoa: EOA, passcode: PASS }, steps)).toBe('memory_check_failed')
		expect(calls).toEqual(['seal', 'open'])
	})

	it('S3 a failed in-memory decrypt (verify or unlock) is not written', async () => {
		const { steps, calls } = realSteps({ openInMemory: async () => ({ code: 'unlock_failed' }) })
		expect(await setPasscodeThenSync({ phrase: PHRASE, eoa: EOA, passcode: PASS }, steps)).toBe('memory_check_failed')
		expect(calls).not.toContain('write')
	})

	it('S4 the first sync is not complete unless the shell answers ok with decrypted:true: the written record stays, nothing is written again', async () => {
		for (const answer of ['unlock_failed', 'verify_failed', 'no_answer']) {
			const { steps, calls } = realSteps({ firstSyncWithPasscode: async () => (answer === 'x' ? 'ok' : 'not_completed') })
			expect(await setPasscodeThenSync({ phrase: PHRASE, eoa: EOA, passcode: PASS }, steps)).toBe('sync_not_completed')
			expect(calls.filter((c) => c === 'write')).toHaveLength(1)
		}
	})

	it('S5 the first sync sent by the shell layer carries the passcode with the cipher, and completes only on decrypted:true', async () => {
		const env = await sealMnemonicV3(PHRASE, EOA, PASS)
		if ('code' in env) throw new Error('seal refused in test')
		const sent: Array<{ cipher: unknown; passcode?: string }> = []
		const shell = createShellMnemonicSync({
			send: async () => 'no_answer',
			retryDelaysMs: [],
			wait: async () => undefined,
			log: () => undefined,
			bridgeAvailable: () => true,
			sendCipher: async (_tx, cipher, passcode) => {
				sent.push({ cipher, passcode })
				return { code: 'ok' }
			},
			nextSeq: () => 5,
		})
		const out = await shell.syncCipher(env as unknown as Record<string, unknown>, EOA, PASS)
		expect(out.kind).toBe('synced')
		expect(sent).toHaveLength(1)
		expect(sent[0].passcode).toBe(PASS)
		expect(JSON.stringify(sent[0].cipher)).toBe(JSON.stringify(env))
	})

	it('S6 a later background sync sends the cipher without a passcode', async () => {
		const env = await sealMnemonicV3(PHRASE, EOA, PASS)
		if ('code' in env) throw new Error('seal refused in test')
		const sent: Array<string | undefined> = []
		const shell = createShellMnemonicSync({
			send: async () => 'no_answer',
			retryDelaysMs: [],
			wait: async () => undefined,
			log: () => undefined,
			bridgeAvailable: () => true,
			sendCipher: async (_tx, _c, passcode) => {
				sent.push(passcode)
				return { code: 'ok' }
			},
			nextSeq: () => 6,
		})
		await shell.syncCipher(env as unknown as Record<string, unknown>, EOA)
		expect(sent).toEqual([undefined])
	})

	it('S7 unlock_failed or verify_failed from the shell is not complete and is not retried with the passcode', async () => {
		const env = await sealMnemonicV3(PHRASE, EOA, PASS)
		if ('code' in env) throw new Error('seal refused in test')
		for (const code of ['unlock_failed', 'verify_failed'] as const) {
			let n = 0
			const shell = createShellMnemonicSync({
				send: async () => 'no_answer',
				retryDelaysMs: [0, 0],
				wait: async () => undefined,
				log: () => undefined,
				bridgeAvailable: () => true,
				sendCipher: async () => {
					n += 1
					return { code: code as never }
				},
				nextSeq: () => 7,
			})
			const out = await shell.syncCipher(env as unknown as Record<string, unknown>, EOA, PASS)
			expect(out.kind).toBe('failed')
			expect(n).toBe(1)
		}
	})

	it('S8 the passcode never appears in the log lines of the shell sync', async () => {
		const env = await sealMnemonicV3(PHRASE, EOA, PASS)
		if ('code' in env) throw new Error('seal refused in test')
		const lines: string[] = []
		const shell = createShellMnemonicSync({
			send: async () => 'no_answer',
			retryDelaysMs: [],
			wait: async () => undefined,
			log: (m) => lines.push(m),
			bridgeAvailable: () => true,
			sendCipher: async () => ({ code: 'verify_failed' as never }),
			nextSeq: () => 8,
		})
		await shell.syncCipher(env as unknown as Record<string, unknown>, EOA, PASS)
		expect(lines.length).toBeGreaterThan(0)
		expect(lines.some((l) => l.includes(PASS))).toBe(false)
		expect(lines.some((l) => l.includes(PHRASE))).toBe(false)
	})
})

// 行为变化（EOA 格式检查）：sealMnemonicV3 对不合格 EOA 返回 bad_request；调用方按 seal_refused 处理：不写入、不同步、记录不变
it('EOA 格式不合格：sealMnemonicV3 返回 bad_request，调用方按 seal_refused 处理（不写入、不同步）', async () => {
	const { steps, calls } = realSteps()
	expect(await sealMnemonicV3(PHRASE, '0x1234', PASS)).toEqual({ code: 'bad_request' })
	expect(await setPasscodeThenSync({ phrase: PHRASE, eoa: '0x1234', passcode: PASS }, steps)).toBe('seal_refused')
	expect(calls).toEqual(['seal'])
})
