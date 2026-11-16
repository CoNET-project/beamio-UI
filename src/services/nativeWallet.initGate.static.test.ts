/**
 * Y.75 / Y.39 #7: the native init is sent only for notReadyReason g1_uninitialized (with the EOA hint). A not_ready with
 * unreadable, or without a reason, never sends an init. Static check of the gate condition in reachNativeWallet.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'nativeWallet.ts'), 'utf8')

describe('native init gate (Y.75)', () => {
	const fn = src.slice(src.indexOf('export async function reachNativeWallet'), src.indexOf('/** `tag` and `eoa`'))

	it('requires notReadyReason g1_uninitialized before any init', () => {
		expect(fn).toContain("state.status === 'not_ready' && state.notReadyReason === 'g1_uninitialized' && hint")
		expect(fn.indexOf("notReadyReason === 'g1_uninitialized'")).toBeLessThan(fn.indexOf('initShellIdentityOnly('))
	})

	it('no init branch depends on status alone', () => {
		expect(fn).not.toMatch(/state\.status === 'not_ready' && hint/)
	})
})
