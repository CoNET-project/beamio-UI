/**
 * HC-LOCK for walletCredential: a locked native answer is the lock, not a failure.
 * CRED-B1: blob mode refused with code locked -> the `locked` action; nothing is stored, nothing is asked again in a loop.
 * CRED-U1/U2: the unseal answer shares the parser; locked keeps its code (the caller reports need-unlock, not an unseal failure).
 */
import { parseWalletCredentialAnswer, pageCopyAction, type WalletCredentialAnswer } from './walletCredential'

const EOA = '0x1111111111111111111111111111111111111111'
const LOCKED: WalletCredentialAnswer = { kind: 'refused', code: 'locked' }

describe('walletCredential HC-LOCK', () => {
	it('CRED-B1: a locked blob-mode answer is the locked action, not retry, and stores nothing', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: LOCKED })).toBe('locked')
	})

	it('CRED-B1 regression: not_trusted still asks for the update, and another refusal is still a retry', () => {
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { kind: 'refused', code: 'not_trusted' } })).toBe('update_required')
		expect(pageCopyAction({ pageRecordPresent: false, eoa: EOA, answer: { kind: 'refused', code: 'timeout' } })).toBe('retry')
	})

	it('a locked answer on a page that already holds a record is none (nothing to copy)', () => {
		expect(pageCopyAction({ pageRecordPresent: true, eoa: EOA, answer: LOCKED })).toBe('none')
	})

	it('CRED-U1/U2: an envelope error locked keeps its code through the parser', () => {
		expect(parseWalletCredentialAnswer({ type: 'ack', ok: false, error: 'locked' })).toEqual({ kind: 'refused', code: 'locked' })
	})
})
