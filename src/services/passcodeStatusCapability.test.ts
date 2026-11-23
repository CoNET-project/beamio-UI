/**
 * passcodeStatus at the start (0.53.44): the capability gate and the nativeLocked field.
 *  - A shell whose hello does not declare wallet.passcode.v1 receives no passcodeStatus (fail closed, passcodeCommands.ts). Its status is
 *    `not_reported` for both walletState and hasKey (nothing was asked, so nothing failed to read), never `unknown`.
 *  - A declared capability with an error envelope or a timeout stays `unknown` (a read failure: the data is kept and the start retries).
 *  - nativeLocked is a boolean when present; any other value makes the answer unknown.
 */
import { nativeStartRoute, parsePasscodeStatus } from './accountJudgement'
import { passcodeUnknownReason, queryNativePasscodeStatus } from './nativeRecovery'
import { probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'

jest.mock('./nativeChatRouteRegister', () => ({
	...jest.requireActual('./nativeChatRouteRegister'),
	probeNativeCapabilities: jest.fn(),
	requestNativeAck: jest.fn(),
}))
jest.mock('@/utils/cashTreesNativePwaLog', () => ({ publishNativePwaLog: jest.fn() }))

const probe = probeNativeCapabilities as jest.Mock
const ack = requestNativeAck as jest.Mock
const DECLARED = ['identity.native-keys.v1', 'wallet.passcode.v1']
const ok = (result: unknown) => ({ kind: 'payload', payload: { type: 'ack', ok: true, result } })

beforeEach(() => {
	probe.mockReset()
	ack.mockReset()
})

describe('queryNativePasscodeStatus: the wallet.passcode.v1 capability gate', () => {
	it('not declared: no command is sent and the report is not_reported for walletState and hasKey', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: ['identity.native-keys.v1'] })
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'not_reported', hasKey: 'not_reported' })
		expect(ack).not.toHaveBeenCalled()
	})
	it('declared, the shell answers an error envelope: unknown (a read failure)', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: DECLARED })
		ack.mockResolvedValue({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'untrusted_source' } })
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'unknown', hasKey: 'unknown' })
		expect(ack).toHaveBeenCalledTimes(1)
	})
	it('declared, no answer in time: unknown', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: DECLARED })
		ack.mockResolvedValue({ kind: 'timeout' })
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'unknown', hasKey: 'unknown' })
	})
	it('the hello itself unanswered: unknown, no command is sent', async () => {
		probe.mockResolvedValue({ answered: false, capabilities: [] })
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'unknown', hasKey: 'unknown' })
		expect(ack).not.toHaveBeenCalled()
	})
	it('declared, the iOS shape {set, locked, hasKey, walletState, nativeLocked:false}: read as given', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: DECLARED })
		ack.mockResolvedValue(ok({ set: false, locked: false, hasKey: false, walletState: 'absent', nativeLocked: false }))
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'absent', hasKey: false })
	})
	it('declared, nativeLocked true is a valid boolean: the report is still read', async () => {
		probe.mockResolvedValue({ answered: true, capabilities: DECLARED })
		ack.mockResolvedValue(ok({ set: true, locked: true, hasKey: true, walletState: 'locked', nativeLocked: true }))
		await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'locked', hasKey: true })
	})
	it('declared, nativeLocked that is not a boolean: unknown', async () => {
		for (const bad of ['false', 0, null, {}, []]) {
			probe.mockResolvedValue({ answered: true, capabilities: DECLARED })
			ack.mockResolvedValue(ok({ set: false, locked: false, hasKey: false, walletState: 'absent', nativeLocked: bad }))
			await expect(queryNativePasscodeStatus()).resolves.toEqual({ walletState: 'unknown', hasKey: 'unknown' })
		}
	})
})

describe('the nativeLocked field in the status parsers', () => {
	it('parsePasscodeStatus: a boolean nativeLocked is accepted; any other value is unknown', () => {
		expect(parsePasscodeStatus({ set: false, locked: false, hasKey: false, walletState: 'absent', nativeLocked: false })).toBe('absent')
		expect(parsePasscodeStatus({ walletState: 'present', nativeLocked: true })).toBe('present')
		expect(parsePasscodeStatus({ walletState: 'absent', nativeLocked: 'false' })).toBe('unknown')
		expect(parsePasscodeStatus({ nativeLocked: 1 })).toBe('unknown')
		expect(parsePasscodeStatus({ set: true, nativeLocked: false })).toBe('not_reported')
		expect(parsePasscodeStatus({ walletState: 'absent', somethingElse: true })).toBe('unknown')
	})
	it('passcodeUnknownReason: a non-boolean nativeLocked is named, a boolean is not a reason', () => {
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'absent', nativeLocked: false } }, true)).toBeNull()
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'absent', nativeLocked: 'no' } }, true)).toBe('native_locked_not_boolean')
		expect(passcodeUnknownReason({ type: 'ack', ok: true, result: { walletState: 'absent', nativeLocked: false, extra: 1 } }, true)).toBe('extra_field:extra')
	})
})

describe('the start route over the reports of a shell with and without the capability', () => {
	const NOT_DECLARED = { walletState: 'not_reported' as const, hasKey: 'not_reported' as const, walletStatus: 'no_key' }
	it('not declared, pre-read absent, walletStatus no_key: onboarding (data kept)', () => {
		expect(nativeStartRoute({ ...NOT_DECLARED, pre: { kind: 'absent' } })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
	})
	it('not declared, pre-read valid: restore', () => {
		expect(nativeStartRoute({ ...NOT_DECLARED, pre: { kind: 'valid' } })).toEqual({ route: 'restore', reason: 'pre_valid' })
	})
	it('not declared, pre-read cipher or locked: the unlock page', () => {
		expect(nativeStartRoute({ ...NOT_DECLARED, pre: { kind: 'cipher' } }).route).toBe('native_locked')
		expect(nativeStartRoute({ ...NOT_DECLARED, pre: { kind: 'locked' } }).route).toBe('native_locked')
	})
	it('declared but the envelope is an error (unknown, unknown), pre-read absent: retry, never onboarding', () => {
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: 'unknown', hasKey: 'unknown', walletStatus: 'no_key' })).toEqual({ route: 'retry', reason: 'read_failed' })
	})
	it('the iOS shape with nativeLocked false (parsed as absent, hasKey false), pre-read absent: onboarding', () => {
		const state = parsePasscodeStatus({ set: false, locked: false, hasKey: false, walletState: 'absent', nativeLocked: false })
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: state, hasKey: false, walletStatus: 'no_key' })).toEqual({ route: 'onboard', reason: 'confirmed_absent' })
	})
	it('nativeLocked not a boolean (unknown), pre-read absent: retry, never onboarding', () => {
		const state = parsePasscodeStatus({ set: false, locked: false, hasKey: false, walletState: 'absent', nativeLocked: 'false' })
		expect(state).toBe('unknown')
		expect(nativeStartRoute({ pre: { kind: 'absent' }, walletState: state, hasKey: 'unknown', walletStatus: 'no_key' }).route).toBe('retry')
	})
})
