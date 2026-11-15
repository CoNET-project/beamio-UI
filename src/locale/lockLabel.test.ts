/**
 * The passcode sign-out entry label. The project owner approved "Lock" (English) and "锁定" (Simplified Chinese).
 * These are the only two UI locales in the app (i18n.ts). Other languages, if added later, need owner confirmation.
 */
import en from './en.json'
import zhCN from './zh-CN.json'

describe('passcode sign-out entry label', () => {
	it('English reads "Lock"', () => {
		expect((en as { ui: Record<string, string> }).ui.passcode_lock_action).toBe('Lock')
	})
	it('Simplified Chinese reads "锁定"', () => {
		expect((zhCN as { ui: Record<string, string> }).ui.passcode_lock_action).toBe('锁定')
	})
})
