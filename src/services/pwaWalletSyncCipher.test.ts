/**
 * Spec §30 (confirmed 2026-11-22): the pwaWalletSync cipher request and its reply. Completed only on ok with stored:true,
 * readback:"match" and decrypted equal to whether a passcode was sent. Nothing here decrypts or writes; the shell does.
 */
const sent: Array<Record<string, unknown>> = []
let nextAnswer: Record<string, unknown> = { kind: 'payload', payload: { type: 'ack', ok: true, result: {} } }
jest.mock('./shellRecordTransport', () => ({
	sendShellWalletSyncCommand: async (cmd: Record<string, unknown>) => {
		sent.push(cmd)
		return (globalThis as { __nextAnswer?: unknown }).__nextAnswer ?? { kind: 'payload', payload: { type: 'ack', ok: true, result: {} } }
	},
}))
import { mapCipherSyncReply, sendPwaWalletSyncCipher, isMnemonicCipherEnvelope } from './pwaWalletSyncTransport'

const EOA = '0xd49251e1e9f4d4d5bac808861fa4ce23053c986f'
const ENV = { v: 3, mode: 'passcode', eoa: EOA, kdf: 'argon2id/m=32768/t=3/p=1/dkLen=32', salt: 'AAECAwQFBgcICQoLDA0ODw==', iv: 'AAECAwQFBgcICQoL', alg: 'AES-256-GCM', ct: 'diJrzOt3Kj4OV+2RgkYviy/MVT7Zv9/sEdeDl58hRg1GChr8OLJv/xs5AEXM9cvzWIZVCHKjDsW1UB8AqBKhqhVUpOImaTLkmq816W0abAHJvt5SzkAnyYQEys0=' }
const ack = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })
const err = (error: string, extra: Record<string, unknown> = {}) => ({ kind: 'payload', payload: { type: 'ack', ok: false, error, ...extra } })
const setAnswer = (a: unknown) => {
	;(globalThis as { __nextAnswer?: unknown }).__nextAnswer = a
}

beforeEach(() => {
	sent.length = 0
	setAnswer(undefined)
})

describe('the request shape (spec 30.6): {type, reqId, seq, cipher}, the cipher exactly as stored; passcode only when given', () => {
	it('trustedOrigin is not set by the page: the shell adds it on its side (Android NativeSyncAck.trusted reads body.trustedOrigin set by the shell)', async () => {
		setAnswer(ack({ code: 'ok', stored: true, readback: 'match', decrypted: false }))
		await sendPwaWalletSyncCipher('pwaWalletSync', 10, ENV)
		expect('trustedOrigin' in sent[0]).toBe(false)
	})
	it('no passcode: the stored envelope is sent unchanged and no phrase, eoa or passcode field is added', async () => {
		setAnswer(ack({ code: 'ok', stored: true, readback: 'match', decrypted: false }))
		await sendPwaWalletSyncCipher('pwaWalletSync', 7, ENV)
		expect(sent).toHaveLength(1)
		expect(Object.keys(sent[0]).sort()).toEqual(['cipher', 'reqId', 'seq', 'type'])
		expect(JSON.stringify(sent[0].cipher)).toBe(JSON.stringify(ENV))
		expect(sent[0].type).toBe('pwaWalletSync')
	})

	it('with a passcode: the passcode is added (the decrypted reply is then required)', async () => {
		setAnswer(ack({ code: 'ok', stored: true, readback: 'match', decrypted: true }))
		const r = await sendPwaWalletSyncCipher('pwaWalletSync', 8, ENV, '482913')
		expect(sent[0].passcode).toBe('482913')
		expect(r).toEqual({ code: 'ok' })
	})

	it('a malformed envelope is bad_request and nothing is sent', async () => {
		expect(await sendPwaWalletSyncCipher('pwaWalletSync', 9, { ...ENV, v: 2 })).toEqual({ code: 'bad_request' })
		expect(await sendPwaWalletSyncCipher('pwaWalletSync', 0, ENV)).toEqual({ code: 'bad_request' })
		expect(sent).toHaveLength(0)
		expect(isMnemonicCipherEnvelope(ENV)).toBe(true)
	})
})

describe('no-passcode cipher reply (spec 30.1): completed only on stored and readback match', () => {
	it('ok, stored:true, readback match, decrypted false: completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: false } }, false)).toEqual({ code: 'ok' })
	})
	it('readback not a match: not completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: true, readback: 'mismatch', decrypted: false } }, false)).toEqual({ code: 'no_answer' })
	})
	it('not stored: not completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: false, readback: 'match', decrypted: false } }, false)).toEqual({ code: 'no_answer' })
	})
	it('a bare ok without the fields is not completed (no completion by a plain ok)', () => {
		expect(mapCipherSyncReply({ ok: true, result: { sync: 'updated' } }, false)).toEqual({ code: 'no_answer' })
	})
	it('decrypted true without a passcode is not completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: true } }, false)).toEqual({ code: 'no_answer' })
	})
})

describe('passcode branch (spec 30.3): a failed decrypt or a failed address check writes nothing and completes nothing', () => {
	it('unlock_failed is a closed code, not completed', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'unlock_failed' }, true)).toEqual({ code: 'unlock_failed' })
	})
	it('verify_failed (address does not match) is a closed code, not completed', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'verify_failed' }, true)).toEqual({ code: 'verify_failed' })
	})
	it('a passcode reply with decrypted:true and the read-back match is completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: true } }, true)).toEqual({ code: 'ok' })
	})
})

describe('write_failed position (spec 30.4, pending v286/v291): kept as it is; never a completion', () => {
	it('the envelope error write_failed keeps the existing mapping', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'write_failed', reason: 'storage_write' }, false)).toEqual({ code: 'write_failed', reason: 'storage_write' })
	})
	it('a result.code write_failed is not a completion (placement not decided)', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'write_failed', stored: false, readback: 'mismatch', decrypted: false } }, false)).toEqual({ code: 'no_answer' })
	})
})
