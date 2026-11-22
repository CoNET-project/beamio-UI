/**
 * An unrecognised passcodeStatus shape gives a named reason: a clear diagnostic, never a silent unknown.
 */
import { passcodeUnknownReason } from './nativeRecovery'

describe('passcodeUnknownReason', () => {
	it('a usable answer has no reason', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'absent', hasKey: false } }, true)).toBeNull()
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { set: true } }, true)).toBeNull()
	})
	it('an unanswered probe, an envelope not ok, and a non-object result are named', () => {
		expect(passcodeUnknownReason(null, false)).toBe('not_answered')
		expect(passcodeUnknownReason({ type: 'ack', ok: false }, true)).toBe('envelope_not_ok')
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: 'x' }, true)).toBe('result_not_object')
	})
	it('an extra field is named by its field name', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'absent', walletStatus: 'no_key' } }, true)).toBe('extra_field:walletStatus')
	})
	it('an unrecognised walletState value is printed as other (the code whitelist), never the value', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'g0' } }, true)).toBe('wallet_state_unrecognised:other')
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'Some Long Text' } }, true)).toBe('wallet_state_unrecognised:other')
	})
	it('a hasKey that is not a boolean is named', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { hasKey: 'yes' } }, true)).toBe('has_key_not_boolean')
	})
})

import { walletStatusUnknownReason } from './nativeRecovery'

describe('walletStatusUnknownReason', () => {
	it('a usable walletStatus has no reason', () => {
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { status: 'no_key' } }, true)).toBeNull()
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { status: 'not_ready', notReadyReason: 'unreadable' } }, true)).toBeNull()
	})
	it('an unanswered probe, a non-ok envelope, a missing result and a missing status are named', () => {
		expect(walletStatusUnknownReason(null, false)).toBe('not_answered')
		expect(walletStatusUnknownReason({ type: 'ack', ok: false }, true)).toBe('envelope_not_ok')
		expect(walletStatusUnknownReason({ type: 'ack', ok: true }, true)).toBe('result_missing')
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { accountKey: 'x' } }, true)).toBe('status_missing')
	})
	it('an unrecognised status is printed as other (the code whitelist)', () => {
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { status: 'uninitialised' } }, true)).toBe('status_unrecognised:other')
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { status: 'A long free text' } }, true)).toBe('status_unrecognised:other')
	})
})

describe('a mnemonic word in a status code is printed as other', () => {
	it('walletState and status carrying a BIP-39 word print other', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'abandon' } }, true)).toBe('wallet_state_unrecognised:other')
		expect(walletStatusUnknownReason({ type: 'ack', ok: true, result: { status: 'legal' } }, true)).toBe('status_unrecognised:other')
	})
})
