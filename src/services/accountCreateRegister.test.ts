/**
 * @jest-environment node
 *
 * accountCreateRegister (frozen protocol v1): command shape, answer whitelist, one in flight, same-payload replay, restart rule, no password in
 * any log. SYNTHETIC values only.
 */
import { buildAccountCreateRegisterCommand, parseAccountCreateRegisterReply, registerNewAccount, resetAccountCreateRegisterForTest, type RegisterDeps } from './accountCreateRegister'

jest.mock('@/utils/accountCreateRegisterFlag', () => ({ ACCOUNT_CREATE_REGISTER_ENABLED: true, FIRST_IDENTITY_STATUS_ENABLED: true }))
const logs: Array<[string, string]> = []
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: (l: string, m: string) => void logs.push([l, m]) }))
jest.mock('./nativeChatRouteRegister', () => ({ nextReqId: (() => { let n = 100; return () => ++n })(), requestNativeAck: jest.fn() }))

const TAG = 'synthtag'
const PASSWORD = 'Pw-SYNTHETIC-9z'
const WALLET = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const SIG = '0x' + 'ab'.repeat(65)
const RECOVER = [{ hash: '0xh1', encrypto: 'enc1' }, { hash: '0xh2', encrypto: 'enc2' }]
const CODE = '3yZe7d' // base58 characters only

const okReply = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ type: 'ack', ok: true, reqId: 101, result: { accountName: TAG, wallet: WALLET, signMessage: SIG, recover: RECOVER, recoverCodeBase58: CODE, ...over }, ...top })

function deps(over: Partial<RegisterDeps> = {}): RegisterDeps & { sent: unknown[]; forwarded: unknown[] } {
	const sent: unknown[] = []
	const forwarded: unknown[] = []
	return {
		sent,
		forwarded,
		send: async (cmd) => {
			sent.push(cmd)
			return okReply()
		},
		forward: async (body) => {
			forwarded.push(body)
			return { kind: 'ok' }
		},
		registryHas: async () => 'no',
		existingEoa: async () => '',
		sleep: async () => undefined,
		...over,
	}
}

beforeEach(() => {
	resetAccountCreateRegisterForTest()
	logs.length = 0
})

describe('the command', () => {
	it('N-01 has exactly four keys: type, reqId, tag, password', () => {
		expect(Object.keys(buildAccountCreateRegisterCommand(7, TAG, PASSWORD)).sort()).toEqual(['password', 'reqId', 'tag', 'type'])
	})
})

describe('the answer, by key whitelist', () => {
	it('N-03 a good success answer gives the four forwarded fields and the code, and nothing else', () => {
		const r = parseAccountCreateRegisterReply(okReply(), TAG)
		expect(r).toEqual({ ok: true, payload: { accountName: TAG, recover: RECOVER, wallet: WALLET, signMessage: SIG }, recoverCodeBase58: CODE })
	})
	it('the fields are read from ack.result only: the flat form (fields at the top level) is bad_response', () => {
		const flat = { type: 'ack', ok: true, reqId: 1, accountName: TAG, wallet: WALLET, signMessage: SIG, recover: RECOVER, recoverCodeBase58: CODE }
		expect(parseAccountCreateRegisterReply(flat, TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply({ type: 'ack', ok: true, reqId: 1 }, TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply({ type: 'ack', ok: true, reqId: 1, result: [] }, TAG)).toEqual({ ok: false, code: 'bad_response' })
	})

	it('N-04 an extra key anywhere makes the whole answer bad_response (success, failure, and inside a recover item)', () => {
		expect(parseAccountCreateRegisterReply(okReply({ privateKey: 'x' }), TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply(okReply({ password: 'x' }), TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply(okReply({}, { extra: 1 }), TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply({ type: 'ack', ok: false, reqId: 1, error: 'bad_tag', extra: 1 }, TAG)).toEqual({ ok: false, code: 'bad_response' })
		expect(parseAccountCreateRegisterReply(okReply({ recover: [{ hash: 'a', encrypto: 'b', plain: 'c' }] }), TAG)).toEqual({ ok: false, code: 'bad_response' })
	})
	it('a wrong shape is bad_response: tag mismatch, bad wallet, bad signature, empty recover, non-base58 code', () => {
		for (const over of [{ accountName: 'other' }, { wallet: '0x12' }, { signMessage: '0x12' }, { recover: [] }, { recoverCodeBase58: 'has space' }, { recoverCodeBase58: '0OIl' }]) {
			expect(parseAccountCreateRegisterReply(okReply(over), TAG)).toEqual({ ok: false, code: 'bad_response' })
		}
	})
	it('every listed failure code is read; an unknown code is "failed", never silent', () => {
		for (const e of ['bad_request', 'bad_tag', 'bad_password', 'tag_taken', 'sign_failed', 'seal_failed', 'not_ready', 'in_flight', 'not_available', 'already_registered']) {
			expect(parseAccountCreateRegisterReply({ type: 'ack', ok: false, reqId: 1, error: e }, TAG)).toEqual({ ok: false, code: e })
		}
		expect(parseAccountCreateRegisterReply({ type: 'ack', ok: false, reqId: 1, error: 'new_code' }, TAG)).toEqual({ ok: false, code: 'failed' })
	})
})

describe('the flow', () => {
	it('sends the command once, forwards the four fields unchanged, returns the code', async () => {
		const d = deps()
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		expect(out).toEqual({ ok: true, wallet: WALLET, recoverCodeBase58: CODE, alreadyRegistered: false })
		expect(d.sent).toHaveLength(1)
		expect(d.forwarded).toEqual([{ accountName: TAG, recover: RECOVER, wallet: WALLET, signMessage: SIG }])
	})

	it('N-07 a second call while one runs is in_flight and sends nothing', async () => {
		let release: (v: unknown) => void = () => undefined
		const d = deps({ send: () => new Promise((r) => { release = r }) })
		const first = registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		const second = await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		expect(second).toEqual({ ok: false, code: 'in_flight', retryable: true })
		release(okReply())
		expect((await first).ok).toBe(true)
	})

	it('N-08 a failed forward is retried with the SAME payload (2, 4, 8 s) and the command is not sent again; a manual retry also reuses it', async () => {
		const waits: number[] = []
		let n = 0
		const d = deps({ forward: async (b) => { d.forwarded.push(b); n += 1; return n <= 4 ? { kind: 'http', status: 503 } : { kind: 'ok' } }, sleep: async (ms) => void waits.push(ms) })
		const first = await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		expect(first).toEqual({ ok: false, code: 'post_failed', retryable: true })
		expect(waits).toEqual([2000, 4000, 8000])
		expect(d.sent).toHaveLength(1)
		const second = await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		expect(second.ok).toBe(true)
		expect(d.sent).toHaveLength(1)
		expect(new Set(d.forwarded.map((b) => JSON.stringify(b))).size).toBe(1)
	})

	it('a 4xx other than 409 stops without a retry; 409 reads the registry and is done when registered', async () => {
		const fwd = jest.fn(async () => ({ kind: 'http' as const, status: 400 }))
		const stop = deps({ forward: fwd })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, stop)).toEqual({ ok: false, code: 'post_refused', retryable: false })
		expect(fwd).toHaveBeenCalledTimes(1)
		resetAccountCreateRegisterForTest()
		const dup = deps({ forward: async () => ({ kind: 'http', status: 409 }), registryHas: async () => 'yes' })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, dup)).toMatchObject({ ok: true, alreadyRegistered: true })
		resetAccountCreateRegisterForTest()
		const unknown = deps({ forward: async () => ({ kind: 'http', status: 409 }), registryHas: async () => 'unknown' })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, unknown)).toEqual({ ok: false, code: 'registry_unknown', retryable: true })
	})

	it('N-09 after a restart (nothing held) the command is called again; already_registered ends it with no addUser, on the account\'s own EOA', async () => {
		const d = deps({ send: async (c) => { d.sent.push(c); return { type: 'ack', ok: false, reqId: 1, error: 'already_registered' } }, existingEoa: async () => WALLET })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).toEqual({ ok: true, wallet: WALLET, recoverCodeBase58: null, alreadyRegistered: true })
		expect(d.sent).toHaveLength(1)
		expect(d.forwarded).toHaveLength(0)
	})

	it('already_registered with no readable own EOA is not a success: try later, still no addUser', async () => {
		const d = deps({ send: async () => ({ type: 'ack', ok: false, reqId: 1, error: 'already_registered' }), existingEoa: async () => '' })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).toEqual({ ok: false, code: 'not_ready', retryable: true })
		expect(d.forwarded).toHaveLength(0)
	})

	it('the page does no registry read before the command (the native layer decides); the first call always sends the command once', async () => {
		const reg = jest.fn(async () => 'yes' as const)
		const d = deps({ registryHas: reg, existingEoa: async () => WALLET })
		expect((await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).ok).toBe(true)
		expect(d.sent).toHaveLength(1)
		expect(reg).not.toHaveBeenCalled()
	})

	it('wallet is forwarded as given (lower case) with the signature and the other fields unchanged', async () => {
		const d = deps()
		await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		const body = d.forwarded[0] as { wallet: string; signMessage: string }
		expect(body.wallet).toBe(WALLET)
		expect(body.wallet).toBe(body.wallet.toLowerCase())
		expect(body.signMessage).toBe(SIG)
	})

	it('sign_failed and seal_failed get one command retry; tag_taken, bad_tag, bad_password and not_available do not', async () => {
		let n = 0
		const flaky = deps({ send: async (c) => { flaky.sent.push(c); n += 1; return n === 1 ? { type: 'ack', ok: false, reqId: 1, error: 'sign_failed' } : okReply() } })
		expect((await registerNewAccount({ tag: TAG, password: PASSWORD }, flaky)).ok).toBe(true)
		expect(flaky.sent).toHaveLength(2)
		for (const e of ['tag_taken', 'bad_tag', 'bad_password', 'not_available']) {
			resetAccountCreateRegisterForTest()
			const d = deps({ send: async (c) => { d.sent.push(c); return { type: 'ack', ok: false, reqId: 1, error: e } } })
			expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).toMatchObject({ ok: false, code: e, retryable: false })
			expect(d.sent).toHaveLength(1)
			expect(d.forwarded).toHaveLength(0)
		}
	})

	it('a bad answer forwards nothing', async () => {
		const d = deps({ send: async () => okReply({ privateKey: 'x' }) })
		expect(await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).toMatchObject({ ok: false, code: 'bad_response' })
		expect(d.forwarded).toHaveLength(0)
	})

	it('N-05 the password and the recover code appear in no log line, on success and on failure paths', async () => {
		await registerNewAccount({ tag: TAG, password: PASSWORD }, deps())
		resetAccountCreateRegisterForTest()
		await registerNewAccount({ tag: TAG, password: PASSWORD }, deps({ forward: async () => ({ kind: 'http', status: 500 }) }))
		resetAccountCreateRegisterForTest()
		await registerNewAccount({ tag: TAG, password: PASSWORD }, deps({ send: async () => ({ type: 'ack', ok: false, reqId: 1, error: 'bad_password' }) }))
		const text = JSON.stringify(logs)
		expect(logs.length).toBeGreaterThan(0)
		expect(text).not.toContain(PASSWORD)
		expect(text).not.toContain(CODE)
		expect(text).not.toContain(SIG)
		expect(text).toContain(`passwordLen=${PASSWORD.length}`)
	})

	it('clarification 2: the forwarded body equals the answer character for character (wallet, signMessage, accountName, recover): no case change, no checksum, no trim, no reorder', async () => {
		const wallet = '0xabcdef0123456789abcdef0123456789abcdef01'
		const reply = okReply({ wallet, recover: [{ hash: ' 0xH1 ', encrypto: 'EncA==' }, { hash: '0xh2', encrypto: 'encB' }] })
		const d = deps({ send: async () => reply })
		await registerNewAccount({ tag: TAG, password: PASSWORD }, d)
		const body = d.forwarded[0] as Record<string, unknown>
		const res = (reply as { result: Record<string, unknown> }).result
		expect(body.wallet).toBe(res.wallet)
		expect(body.signMessage).toBe(res.signMessage)
		expect(body.accountName).toBe(res.accountName)
		expect(JSON.stringify(body.recover)).toBe(JSON.stringify(res.recover))
		expect(Object.keys(body)).toEqual(['accountName', 'recover', 'wallet', 'signMessage'])
		// the checksum form of the same address would differ, and is refused rather than "fixed"
		const { ethers } = require('ethers') as typeof import('ethers')
		const checksum = ethers.getAddress(wallet)
		expect(checksum).not.toBe(wallet)
		expect(parseAccountCreateRegisterReply(okReply({ wallet: checksum }), TAG)).toEqual({ ok: false, code: 'bad_response' })
	})
})

describe('F1 (0.53.51): a 409 means the server did not take this payload, so this payload\'s recover code is never handed on', () => {
	const dup = (registryHas: () => Promise<'yes' | 'no' | 'unknown'>) => deps({ forward: async () => ({ kind: 'http', status: 409 }), registryHas })

	it('409 and the registry has the account: ok, alreadyRegistered, and NO recover code (the no-code path)', async () => {
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, dup(async () => 'yes'))
		expect(out).toEqual({ ok: true, wallet: WALLET, recoverCodeBase58: null, alreadyRegistered: true })
		expect(JSON.stringify(out)).not.toContain(CODE)
	})

	it('409 and the registry read fails or is unknown: registry_unknown, retryable, no code, nothing claimed', async () => {
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, dup(async () => 'unknown'))
		expect(out).toEqual({ ok: false, code: 'registry_unknown', retryable: true })
		expect(JSON.stringify(out)).not.toContain(CODE)
	})

	it('409 and the registry does not hold it: post_refused, not retryable, no code', async () => {
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, dup(async () => 'no'))
		expect(out).toEqual({ ok: false, code: 'post_refused', retryable: false })
		expect(JSON.stringify(out)).not.toContain(CODE)
	})

	it('a plain 2xx still returns the code (the code of a registered payload)', async () => {
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, deps())
		expect(out).toMatchObject({ ok: true, recoverCodeBase58: CODE, alreadyRegistered: false })
	})
})

describe('the pending-record hooks (0.53.51): s before the first send of a payload, a at the 2xx', () => {
	it('beforeFirstForward runs once before the first send, not again by the retries or by a manual retry; afterForwardOk runs at the 2xx only', async () => {
		const order: string[] = []
		let fails = 4
		const d = deps({
			forward: async () => {
				order.push('forward')
				return fails-- > 0 ? { kind: 'http', status: 503 } : { kind: 'ok' }
			},
			beforeFirstForward: () => void order.push('before'),
			afterForwardOk: () => void order.push('after'),
		})
		expect((await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).ok).toBe(false)
		expect(order).toEqual(['before', 'forward', 'forward', 'forward', 'forward'])
		order.length = 0
		fails = 0
		expect((await registerNewAccount({ tag: TAG, password: PASSWORD }, d)).ok).toBe(true)
		expect(order).toEqual(['forward', 'after'])
	})

	it('a new payload (after a restart or a new tag) gets its own first-send call', async () => {
		const before = jest.fn()
		await registerNewAccount({ tag: TAG, password: PASSWORD }, deps({ beforeFirstForward: before }))
		resetAccountCreateRegisterForTest()
		await registerNewAccount({ tag: TAG, password: PASSWORD }, deps({ beforeFirstForward: before }))
		expect(before).toHaveBeenCalledTimes(2)
	})

	it('a throwing hook never stops the registration', async () => {
		const out = await registerNewAccount({ tag: TAG, password: PASSWORD }, deps({ beforeFirstForward: () => { throw new Error('x') }, afterForwardOk: () => { throw new Error('y') } }))
		expect(out).toMatchObject({ ok: true })
	})
})
