/**
 * The passcode command builder and the capability gate (FROZEN protocol sections one, six and seven). Synthetic values only.
 */
import { buildPasscodeCommand, CREDENTIAL_FIELDS, nextPasscodeReqId, PASSCODE_CAPABILITY, PASSCODE_COMMAND_FIELDS, passcodeCapabilityDeclared, sendPasscodeCommand } from './passcodeCommands'
import { SHELL_PASSCODE_REQ_BASE } from '../reqIdSpaces'

const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const P1 = '482159'
const P2 = '703162'
const REQ = nextPasscodeReqId(0)
const BASE = { reqId: REQ, eoa: EOA }

describe('the allowlist per command matches the frozen table', () => {
	it('six commands, with exactly the listed fields', () => {
		expect(Object.keys(PASSCODE_COMMAND_FIELDS).sort()).toEqual(['nativeIdentityCheck', 'nativeRepairProvide', 'passcodeChange', 'passcodeDisable', 'passcodeProvision', 'passcodeStatus', 'passcodeUnlock'])
		expect(PASSCODE_COMMAND_FIELDS.passcodeProvision).toEqual(['type', 'reqId', 'eoa', 'phrase', 'passcode'])
		expect(PASSCODE_COMMAND_FIELDS.passcodeUnlock).toEqual(['type', 'reqId', 'eoa', 'passcode'])
		expect(PASSCODE_COMMAND_FIELDS.passcodeChange).toEqual(['type', 'reqId', 'eoa', 'oldPasscode', 'newPasscode'])
		expect(PASSCODE_COMMAND_FIELDS.passcodeStatus).toEqual(['type', 'reqId', 'eoa'])
	})
	it('the credential fields are exactly the four named in the protocol', () => {
		expect([...CREDENTIAL_FIELDS].sort()).toEqual(['newPasscode', 'oldPasscode', 'passcode', 'phrase'])
	})
	it('the unlock command never carries the phrase (only the passcode crosses)', () => {
		expect(PASSCODE_COMMAND_FIELDS.passcodeUnlock).not.toContain('phrase')
	})
})

describe('buildPasscodeCommand refuses anything outside the allowlist, before anything is sent', () => {
	it('an unknown command', () => {
		expect(buildPasscodeCommand('passcodeRun', { ...BASE, passcode: P1 })).toEqual({ ok: false, reason: 'unknown_command' })
	})
	it('the phrase inside passcodeUnlock is an extra field', () => {
		expect(buildPasscodeCommand('passcodeUnlock', { ...BASE, passcode: P1, phrase: PHRASE })).toEqual({ ok: false, reason: 'extra_field' })
	})
	it('a field the protocol does not list (trustedOrigin) is an extra field', () => {
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, trustedOrigin: 'x' })).toEqual({ ok: false, reason: 'extra_field' })
	})
	it('a missing required field', () => {
		expect(buildPasscodeCommand('passcodeUnlock', { ...BASE })).toEqual({ ok: false, reason: 'missing_field' })
	})
	it('an empty passcode is missing', () => {
		expect(buildPasscodeCommand('passcodeUnlock', { ...BASE, passcode: '' })).toEqual({ ok: false, reason: 'missing_field' })
	})
	it('a malformed address (upper case or short) is a bad value', () => {
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, eoa: EOA.toUpperCase().replace('0X', '0x') })).toEqual({ ok: false, reason: 'bad_value' })
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, eoa: '0x12' })).toEqual({ ok: false, reason: 'bad_value' })
	})
	it('a reqId that is not a safe non-negative integer is a bad value', () => {
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, reqId: -1 })).toEqual({ ok: false, reason: 'bad_value' })
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, reqId: 1.5 })).toEqual({ ok: false, reason: 'bad_value' })
	})
	it('type is the command name, not an input field: passing it is an extra field', () => {
		expect(buildPasscodeCommand('passcodeStatus', { ...BASE, type: 'passcodeStatus' })).toEqual({ ok: false, reason: 'extra_field' })
	})
	it('a valid command builds with exactly its allowed fields', () => {
		const built = buildPasscodeCommand('passcodeChange', { ...BASE, oldPasscode: P1, newPasscode: P2 })
		expect(built).toEqual({ ok: true, command: { type: 'passcodeChange', reqId: REQ, eoa: EOA, oldPasscode: P1, newPasscode: P2 } })
	})
})

describe('the capability gate: a shell that does not declare wallet.passcode.v1 gets no passcode command', () => {
	it('the capability string is the passcode capability, not the native-keys one', () => {
		expect(PASSCODE_CAPABILITY).toBe('wallet.passcode.v1')
		expect(passcodeCapabilityDeclared(['identity.native-keys.v1'])).toBe(false)
		expect(passcodeCapabilityDeclared(['identity.native-keys.v1', 'wallet.passcode.v1'])).toBe(true)
	})
	it('not declared: nothing is sent, even for a well-formed command', () => {
		const sent: Record<string, unknown>[] = []
		const out = sendPasscodeCommand(['identity.native-keys.v1'], 'passcodeUnlock', { ...BASE, passcode: P1 }, (c) => sent.push(c))
		expect(out).toEqual({ kind: 'refused', reason: 'capability_missing' })
		expect(sent).toEqual([])
	})
	it('declared and well formed: the command is sent once, with its allowed fields', () => {
		const sent: Record<string, unknown>[] = []
		const out = sendPasscodeCommand([PASSCODE_CAPABILITY], 'passcodeUnlock', { ...BASE, passcode: P1 }, (c) => sent.push(c))
		expect(out).toEqual({ kind: 'sent' })
		expect(sent).toEqual([{ type: 'passcodeUnlock', reqId: REQ, eoa: EOA, passcode: P1 }])
	})
	it('declared but refused by the allowlist: nothing is sent', () => {
		const sent: Record<string, unknown>[] = []
		const out = sendPasscodeCommand([PASSCODE_CAPABILITY], 'passcodeUnlock', { ...BASE, passcode: P1, phrase: PHRASE }, (c) => sent.push(c))
		expect(out).toEqual({ kind: 'refused', reason: 'extra_field' })
		expect(sent).toEqual([])
	})
})

describe('the reqId comes from the page passcode range', () => {
	it('the first counter value is the range base', () => {
		expect(nextPasscodeReqId(0)).toBe(SHELL_PASSCODE_REQ_BASE)
	})
})
