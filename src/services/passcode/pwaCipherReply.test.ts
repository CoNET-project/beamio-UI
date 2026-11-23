/**
 * @jest-environment node
 *
 * f3 follow-up (item 1): the cipher path keeps the f2 closed codes. unlock_failed and verify_failed are kept as they are;
 * neither is a completed sync. Only ok with stored:true, readback "match" and decrypted equal to the passcode branch is completed.
 */
import { mapCipherSyncReply } from '../pwaWalletSyncTransport'

const done = (withPasscode: boolean) => ({ ok: true, result: { code: 'ok', stored: true, readback: 'match', decrypted: withPasscode } })

describe('cipher reply mapping keeps the f2 closed codes', () => {
	it('unlock_failed is kept with its code, with a passcode', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'unlock_failed' }, true)).toEqual({ code: 'unlock_failed' })
	})
	it('verify_failed is kept with its code, with and without a passcode', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'verify_failed' }, true)).toEqual({ code: 'verify_failed' })
		expect(mapCipherSyncReply({ ok: false, error: 'verify_failed' }, false)).toEqual({ code: 'verify_failed' })
	})
	it('neither closed code is mistaken for a completed sync', () => {
		expect(mapCipherSyncReply({ ok: false, error: 'unlock_failed' }, true).code).not.toBe('ok')
		expect(mapCipherSyncReply({ ok: false, error: 'verify_failed' }, true).code).not.toBe('ok')
	})
	it('ok without a confirmed read-back, or with decrypted not equal to the passcode branch, is not completed', () => {
		expect(mapCipherSyncReply({ ok: true, result: { code: 'ok', stored: true, readback: 'mismatch', decrypted: true } }, true).code).not.toBe('ok')
		expect(mapCipherSyncReply(done(false), true).code).not.toBe('ok')
		expect(mapCipherSyncReply(done(true), false).code).not.toBe('ok')
	})
	it('the confirmed ok with the passcode branch is completed', () => {
		expect(mapCipherSyncReply(done(true), true)).toEqual({ code: 'ok' })
	})
})
