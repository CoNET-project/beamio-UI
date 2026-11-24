/**
 * @jest-environment node
 */
/**
 * 0.53.47: the trusted recovery bridge returns the plaintext mnemonic (no app passcode) and the page derives the address from it. The
 * reply's eoa is optional and never a gate: missing, or different from the derived address, the derived address is used (a mismatch logs
 * one diagnostic without an address). Everything else stays: the phrase must be valid; the ack, the trusted-source and request/seq
 * refusals, the cipher, locked, read_error, not_ready and confirmed_missing answers read as before. SYNTHETIC values only.
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import * as fs from 'fs'
import * as path from 'path'
import { prereadFromAnswer } from './nativeRecovery'

const logged: Array<[string, string]> = []
jest.mock('@/utils/cashTreesNativePwaLog', () => ({
	publishNativePwaLog: (level: string, message: string) => {
		logged.push([level, message])
	},
}))
beforeEach(() => {
	logged.length = 0
})

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const OTHER = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

describe('plaintext without eoa (the only relaxed case)', () => {
	it('missing eoa → valid on the derived address', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})
	it('eoa null is the same as missing', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: null }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})
	it('the phrase rules are the same with and without an eoa (here: surrounding whitespace)', () => {
		const m = `  ${PHRASE} `
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: m })).kind).toBe(prereadFromAnswer(ack({ code: 'ok', mnemonic: m, eoa: EOA })).kind)
	})
})

describe('a reply eoa is never a gate', () => {
	it('equal to the derived address (any case): valid, no diagnostic', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA.toUpperCase().replace('0X', '0x') }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
		expect(logged).toEqual([])
	})
	it('different from the derived address (an old shell): valid on the DERIVED address, one diagnostic with no address and no secret', () => {
		const r = prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: OTHER }))
		expect(r).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
		expect(JSON.stringify(r)).not.toContain(OTHER)
		expect(logged).toEqual([['warn', '[preread] eoa field ignored (mismatch)']])
		const text = JSON.stringify(logged).toLowerCase()
		expect(text).not.toContain(OTHER.toLowerCase())
		expect(text).not.toContain(EOA)
		expect(text).not.toContain('abandon')
	})
	it('empty or non-string eoa fields are ignored the same way (valid on the derived address)', () => {
		for (const bad of ['', '   ', 0, false, {}, []]) {
			expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: bad as unknown }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
		}
	})
})

describe('reverse cases: only the eoa field is relaxed, every other check holds', () => {
	it('an invalid phrase is unknown with or without an eoa (word list, checksum, shape)', () => {
		const badChecksum = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
		for (const m of [badChecksum, 'not a phrase', '', 'abandon', 42 as unknown as string]) {
			expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: m })).kind).toBe('unknown')
			expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: m, eoa: EOA })).kind).toBe('unknown')
		}
	})
	it('request and seq binding: a refusal (stale_seq, bad_request) is unknown even when the result carries a phrase', () => {
		for (const error of ['stale_seq', 'bad_request', 'key_over_bridge_refused']) {
			const out = prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error, result: { code: 'ok', mnemonic: PHRASE } } })
			expect(out.kind).toBe('unknown')
		}
	})
	it('trusted source: untrusted_source is unknown, and a payload that is not an ack never yields a phrase', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source', result: { code: 'ok', mnemonic: PHRASE } } }).kind).toBe('unknown')
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'event', ok: true, result: { code: 'ok', mnemonic: PHRASE } } }).kind).toBe('unknown')
		expect(prereadFromAnswer({ kind: 'timeout' }).kind).toBe('unknown')
		expect(prereadFromAnswer({ kind: 'not_supported' }).kind).toBe('unknown')
	})
	it('a cipher answer is still the stored envelope, with no address derived', () => {
		const cipher = { v: 3, mode: 'passcode', eoa: OTHER }
		expect(prereadFromAnswer(ack({ code: 'ok', cipher }))).toEqual({ kind: 'cipher', cipher })
	})
	it('locked, read_error, not_ready, confirmed_missing, unknown_command read as before', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'locked' } })).toEqual({ kind: 'locked' })
		expect(prereadFromAnswer(ack({ code: 'read_error' }))).toEqual({ kind: 'unknown', reason: 'read_error' })
		expect(prereadFromAnswer(ack({ code: 'not_ready' }))).toEqual({ kind: 'unknown', reason: 'not_ready' })
		expect(prereadFromAnswer(ack({ code: 'confirmed_missing' }))).toEqual({ kind: 'absent' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'unknown_command' } })).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})
	it('ok without a mnemonic or cipher is unknown, never valid', () => {
		expect(prereadFromAnswer(ack({ code: 'ok' })).kind).toBe('unknown')
		expect(prereadFromAnswer(ack({ code: 'ok', eoa: EOA })).kind).toBe('unknown')
	})
})

describe('static pins', () => {
	const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
	it('sendNativeMnemonicPreread has no production caller: it takes no part in the account judgement', () => {
		const roots = ['services', 'components', 'pages', 'hooks', 'utils']
		const hits: string[] = []
		const walk = (dir: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name)
				if (e.isDirectory()) walk(p)
				else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && /sendNativeMnemonicPreread/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(path.join(__dirname, '..'), p))
			}
		}
		for (const r of roots) if (fs.existsSync(path.join(__dirname, '..', r))) walk(path.join(__dirname, '..', r))
		expect(hits).toEqual(['services/pwaWalletSyncTransport.ts'])
	})
	it('chat identity and fingerprint checks are not reached from the preread parser', () => {
		const text = src('services/nativeRecovery.ts')
		const fn = text.slice(text.indexOf('function prereadFromCode'))
		const code = fn.slice(0, fn.indexOf('\n}\n')).replace(/\/\/.*$/gm, '')
		expect(code).not.toMatch(/pgp|fingerprint|chatIdentity|identityPublic/i)
		for (const f of ['services/nativePgpRestore.ts', 'services/shellChatStart.ts', 'services/nativeIdentityPublic.ts']) {
			expect(src(f)).not.toMatch(/prereadFromAnswer|prereadFromCode|queryNativeMnemonicPreread/)
		}
	})
	it('the preread, the entry gate and the unlock page never put a phrase or a passcode into a log call', () => {
		for (const f of ['services/nativeRecovery.ts', 'components/AppEntryGate.tsx', 'components/PrereadPasscodeUnlock.tsx']) {
			const text = src(f)
			const calls = text.match(/publishNativePwaLog\([^;]*\)/g) ?? []
			for (const c of calls) expect(c).not.toMatch(/\$\{\s*(phrase|pre\.phrase|mnemonic|passcode|digits|cipher|pre\.eoa|eoa)\b/)
			expect(text).not.toMatch(/console\.(log|info|warn|error|debug)\([^)]*\b(phrase|mnemonic|passcode)\b/)
		}
	})
})
