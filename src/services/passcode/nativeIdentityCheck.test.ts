import { buildPasscodeCommand } from './passcodeCommands'
import { buildNativeIdentityCheck, decideNativeIdentityCheck } from './nativeIdentityCheck'

const EOA = '0x1111111111111111111111111111111111111111'

describe('nativeIdentityCheck command', () => {
	test('builds from eoa and reqId only', () => {
		expect(buildNativeIdentityCheck(EOA, 7)).toEqual({ ok: true, command: { type: 'nativeIdentityCheck', reqId: 7, eoa: EOA } })
	})
	test('refuses a negative reqId', () => {
		expect(buildNativeIdentityCheck(EOA, -1)).toEqual({ ok: false, reason: 'bad_value' })
	})
	test('a mnemonic or passcode field is an extra field and never built', () => {
		expect(buildPasscodeCommand('nativeIdentityCheck', { reqId: 1, eoa: EOA, phrase: 'x y' })).toEqual({ ok: false, reason: 'extra_field' })
		expect(buildPasscodeCommand('nativeIdentityCheck', { reqId: 1, eoa: EOA, passcode: '123456' })).toEqual({ ok: false, reason: 'extra_field' })
	})
	test('refuses a malformed eoa', () => {
		expect(buildNativeIdentityCheck('0xABC', 1)).toEqual({ ok: false, reason: 'bad_value' })
	})
})

describe('decideNativeIdentityCheck', () => {
	test('match true continues', () => {
		expect(decideNativeIdentityCheck({ ok: true, match: true })).toBe('continue')
	})
	test('match false goes to the account conflict flow', () => {
		expect(decideNativeIdentityCheck({ ok: true, match: false })).toBe('account_conflict')
	})
	test('not_ready is not a answer: hold', () => {
		expect(decideNativeIdentityCheck({ ok: false, error: 'not_ready' })).toBe('hold')
	})
	test('locked uses the passcodeUnlock path, like not_ready', () => {
		expect(decideNativeIdentityCheck({ ok: false, error: 'locked' })).toBe('normal_unlock')
	})
	test('bad_request holds, never continues', () => {
		expect(decideNativeIdentityCheck({ ok: false, error: 'bad_request' })).toBe('hold')
	})
	test('malformed, missing or unknown replies hold (fail closed)', () => {
		expect(decideNativeIdentityCheck(null)).toBe('hold')
		expect(decideNativeIdentityCheck('ok')).toBe('hold')
		expect(decideNativeIdentityCheck({ ok: true })).toBe('hold')
		expect(decideNativeIdentityCheck({ ok: true, match: 'yes' })).toBe('hold')
		expect(decideNativeIdentityCheck({ ok: false, error: 'timeout' })).toBe('hold')
		expect(decideNativeIdentityCheck({})).toBe('hold')
	})
})
