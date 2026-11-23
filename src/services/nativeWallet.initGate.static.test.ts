/**
 * Y.75 / Y.39 #7 and Y.163: the native init is sent for notReadyReason g1_uninitialized (with the EOA hint), and on iOS also for
 * unreadable (one init, Y.163). A not_ready on Android, or without a reason, never sends an init. Static check of the gate condition.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'nativeWallet.ts'), 'utf8')

describe('native init gate (Y.75, Y.163)', () => {
	const fn = src.slice(src.indexOf('export async function reachNativeWallet'), src.indexOf('/** `tag` and `eoa`'))

	it('requires g1_uninitialized, or iOS unreadable, with the EOA hint, before any init', () => {
		expect(fn).toContain("(state.status === 'not_ready' && state.notReadyReason === 'g1_uninitialized') || iosUnreadableInit) && hint")
		expect(fn.indexOf("notReadyReason === 'g1_uninitialized'")).toBeLessThan(fn.indexOf('initShellIdentityOnly('))
	})

	it('unreadable sends an init only on iOS', () => {
		expect(fn).toContain("const iosUnreadableInit = state.status === 'not_ready' && state.notReadyReason === 'unreadable' && isIosNativeShell()")
	})

	it('no init branch depends on status alone', () => {
		expect(fn).not.toMatch(/state\.status === 'not_ready' && hint/)
	})
})
