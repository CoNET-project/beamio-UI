/**
 * @jest-environment node
 */
/**
 * spec §316（preread 原样返回 current）: the closed `result {code}` answers of nativeMnemonicPreread, run through the
 * real parser and the real queryNativeMnemonicPreread. Cases PRR-01 to PRR-07 (vectors preread-returns-current-record-as-is.v1.json).
 * SYNTHETIC values only: the BIP-39 public test vector and the synthetic v3 envelope.
 */
import { webcrypto } from 'crypto'
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
	Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
import { buildNativeMnemonicPrereadCommand, prereadFromAnswer, queryNativeMnemonicPreread } from './nativeRecovery'
import { createShellTxSeq, type SeqStorage } from './shellTxSeq'

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const CIPHER = {
	v: 3,
	mode: 'passcode',
	eoa: '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f',
	kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32',
	salt: 'AAECAwQFBgcICQoLDA0ODw==',
	iv: 'AAECAwQFBgcICQoL',
	alg: 'AES-256-GCM',
	ct: 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0=',
}
const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

function memoryStorage(): SeqStorage {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

describe('PRR-01: a plaintext current mnemonic is returned as stored (no passcode, no unlock)', () => {
	it('ok + mnemonic: valid, the EOA derived from the phrase, the phrase unchanged', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE, eoa: EOA }))).toEqual({ kind: 'valid', eoa: EOA, phrase: PHRASE })
	})

	it('ok + mnemonic that does not parse is unknown, never valid', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: 'not a bip39 phrase at all' }))).toEqual({ kind: 'unknown' })
	})
})

describe('PRR-02 / PRR-05: a ciphertext current record is returned without a passcode and never as plaintext', () => {
	it('ok + cipher: cipher returned as stored; no mnemonic field; the request carries no passcode', async () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: CIPHER }))).toEqual({ kind: 'cipher', cipher: CIPHER })
		const seen: Array<Record<string, unknown>> = []
		const send = async (cmd: { type: string; seq: number }) => {
			seen.push(cmd as unknown as Record<string, unknown>)
			return ack({ code: 'ok', cipher: CIPHER })
		}
		const nextSeq = createShellTxSeq(memoryStorage(), () => 1000)
		const out = await queryNativeMnemonicPreread(nextSeq, send)
		expect(out).toEqual({ kind: 'cipher', cipher: CIPHER })
		expect(seen).toHaveLength(1)
		expect(Object.keys(seen[0]).sort()).toEqual(['seq', 'type'])
	})

	it('PRR-05: the request is the same with the SDK not initialised and no passcode (no gate on the pre-read)', () => {
		expect(Object.keys(buildNativeMnemonicPrereadCommand(3)).sort()).toEqual(['seq', 'type'])
	})

	it('ok + cipher that is not an object is unknown, not cipher', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: 'raw-string' }))).toEqual({ kind: 'unknown' })
	})
})

describe('PRR-03: confirmed_missing is the only confirmed absence', () => {
	it('confirmed_missing: absent', () => {
		expect(prereadFromAnswer(ack({ code: 'confirmed_missing' }))).toEqual({ kind: 'absent' })
	})
})

describe('PRR-04: a read failure is a bridge fault, not a confirmed absence, and keeps the data', () => {
	it('read_error: unknown with reason read_error (never absent)', () => {
		const out = prereadFromAnswer(ack({ code: 'read_error' }))
		expect(out).toEqual({ kind: 'unknown', reason: 'read_error' })
		expect(out.kind).not.toBe('absent')
	})

	it('a code outside the closed set is unknown: an unlock or verify code is never a preread answer', () => {
		for (const code of ['unknown', 'unlock_failed', 'verify_failed', 'passcode_not_provided', 'passcode_required', '']) {
			expect(prereadFromAnswer(ack({ code }))).toEqual({ kind: 'unknown' })
		}
	})
})

describe('PRR-07: the passcode state of another command does not answer the pre-read', () => {
	it('a passcode_not_provided result is never absent and never a verdict on the pre-read', () => {
		expect(prereadFromAnswer(ack({ code: 'passcode_not_provided' }))).toEqual({ kind: 'unknown' })
	})

	it('the pre-read answer with a cipher is cipher whatever the walletStatus of the same start says', () => {
		// the parser reads only the pre-read answer; the walletStatus answer is a separate command and is never passed in here
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: CIPHER }))).toEqual({ kind: 'cipher', cipher: CIPHER })
	})
})

describe('the legacy state shape stays readable for shells that have not moved yet', () => {
	it('{state:"absent"} is still absent', () => {
		expect(prereadFromAnswer(ack({ code: 'confirmed_missing' }))).toEqual({ kind: 'absent' })
	})
})

describe('the ok plaintext answer carries no eoa: the address is derived from the mnemonic (BIP-39, m/44 index 0)', () => {
	it('ok + mnemonic without an eoa is the capability-missing path (unsupported), never valid and never a reference address', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', mnemonic: PHRASE }))).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})
	it('the cipher answer carries no eoa either and is returned as the stored envelope (not decrypted, no address derived here)', () => {
		expect(prereadFromAnswer(ack({ code: 'ok', cipher: CIPHER }))).toEqual({ kind: 'cipher', cipher: CIPHER })
	})
})
