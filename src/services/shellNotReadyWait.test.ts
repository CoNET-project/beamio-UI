import { shellNotReadyWaitReason } from './shellNotReadyWait'

const WAIT = /wait and retry, no creation, recovery or import entry/

describe('shell guard: any walletStatus that is not an explicit no_key waits (2026-11-21)', () => {
	test('the original leak combination (walletState absent, idb absent, walletStatus not_ready) waits', () => {
		expect(shellNotReadyWaitReason({ isShell: true, walletStatus: 'not_ready', presence: 'no_account' })).toMatch(WAIT)
	})

	test('every non-no_key status waits when the page holds no valid mnemonic', () => {
		for (const walletStatus of ['not_ready', 'unknown', 'unavailable', 'timeout', 'read_failed', 'not_reported', 'locked', 'unlocked']) {
			for (const presence of ['no_account', 'undetermined']) {
				expect(shellNotReadyWaitReason({ isShell: true, walletStatus, presence })).toMatch(WAIT)
			}
		}
	})

	test('an explicit no_key is not held here (the existing onboarding path)', () => {
		expect(shellNotReadyWaitReason({ isShell: true, walletStatus: 'no_key', presence: 'no_account' })).toBeNull()
	})

	test('a valid mnemonic on the page (has_account) is not held, whatever the native status', () => {
		for (const walletStatus of ['not_ready', 'locked', 'unlocked', 'unknown']) {
			expect(shellNotReadyWaitReason({ isShell: true, walletStatus, presence: 'has_account' })).toBeNull()
		}
	})

	test('a browser is never held by this guard', () => {
		expect(shellNotReadyWaitReason({ isShell: false, walletStatus: 'not_ready', presence: 'no_account' })).toBeNull()
	})
})
