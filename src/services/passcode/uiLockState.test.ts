import { PASSCODE_CAPABILITY } from './passcodeCommands'
import { reportUiLocked, uiUnlockStep, UI_LOCKED_COMMAND } from './uiLockState'

describe('uiLockState report', () => {
	test('sends only {type, locked:true}', () => {
		expect(UI_LOCKED_COMMAND).toEqual({ type: 'uiLockState', locked: true })
	})

	test('sends when the shell declared the passcode capability', async () => {
		const sent: Record<string, unknown>[] = []
		const out = await reportUiLocked([PASSCODE_CAPABILITY], async (c) => {
			sent.push(c)
		})
		expect(out).toEqual({ kind: 'sent' })
		expect(sent).toEqual([{ type: 'uiLockState', locked: true }])
	})

	test('refused without the capability: nothing is sent (fail closed)', async () => {
		const send = jest.fn(async () => undefined)
		const out = await reportUiLocked(['identity.native-keys.v1'], send)
		expect(out).toEqual({ kind: 'refused', reason: 'capability_missing' })
		expect(send).not.toHaveBeenCalled()
	})

	test('a failing send is reported as failed, not thrown', async () => {
		const out = await reportUiLocked([PASSCODE_CAPABILITY], async () => {
			throw new Error('bridge down')
		})
		expect(out).toEqual({ kind: 'failed' })
	})
})

describe('step after a UI unlock', () => {
	test('native already unlocked: nativeIdentityCheck, never passcodeUnlock', () => {
		expect(uiUnlockStep(true)).toBe('native_identity_check')
	})
	test('native locked: passcodeUnlock', () => {
		expect(uiUnlockStep(false)).toBe('passcode_unlock')
	})
})
