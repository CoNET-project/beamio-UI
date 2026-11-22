/**
 * @jest-environment node
 *
 * (onboarding creation and write settlement), source checks. OB-1…OB-6 are the clauses; the test IDs follow them.
 * Limits: the native create result carries no reason field, so OB-3 and OB-4 are checked as "no completion on any write_failed".
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('onboarding creation and completion', () => {
	it('OB-1/2/3/4: write_failed (any reason) does not complete, shows the try-later text, and does not announce or notify', () => {
		const at = src.indexOf("if (code === 'write_failed' || code === 'readback_failed') {")
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at, at + 1600)
		expect(block).toContain("setCreateError(tu('create_account_try_later'))")
		expect(block).not.toContain('announceNativeWalletEstablished')
		expect(block).not.toContain('notifyNativeWalletReady')
	})

	it('OB-5: a locked open answer is not a completion and not a second create', () => {
		const at = src.indexOf("if (opened.reason === 'locked') {")
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at, at + 160)
		expect(block).toContain("setCreateError(tu('create_account_try_later'))")
		expect(block).toContain('return')
		expect(block).not.toContain('announceNativeWalletEstablished')
	})

	it('OB-6: completion (announce and notify) appears only on the ok branch, and no addUser call is in the native create listener', () => {
		const start = src.indexOf('onNativeAccountCreateResult((accepted)')
		expect(start).toBeGreaterThan(0)
		const ok = src.indexOf("if (code === 'ok') {", start)
		expect(ok).toBeGreaterThan(start)
		const announce = src.indexOf('announceNativeWalletEstablished()', ok)
		expect(announce).toBeGreaterThan(ok)
		const listener = src.slice(start, src.indexOf('return () => {', start))
		expect(listener).not.toMatch(/addUser|newUser|createRecover/)
		// the announce is not reached before the ok branch
		expect(src.slice(start, ok)).not.toContain('announceNativeWalletEstablished()')
	})
})

describe('write_failed reason handling', () => {
	it('OB-2: any write_failed sets the reread-required flag before any later action', () => {
		const at = src.indexOf("if (code === 'write_failed' || code === 'readback_failed') {")
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 160)).toContain('createRereadRequiredRef.current = true')
	})

	it('OB-4: old_copy_unverified shows the explanation and no retry button text', () => {
		const at = src.indexOf("accepted.reason === 'old_copy_unverified'")
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 500)).toContain("setCreateError(tu('shell_sync_old_copy_unverified_body'))")
	})

	it('OB-2b: the open path rereads walletEoaAddress before the open request when the flag is set', () => {
		const flag = src.indexOf('if (createRereadRequiredRef.current) {')
		const reread = src.indexOf('readWalletEoaAddress()', flag)
		const open = src.indexOf('const opened = await nativeAccountCreateOpen(trimmedTag)', flag)
		expect(flag).toBeGreaterThan(0)
		expect(reread).toBeGreaterThan(flag)
		expect(open).toBeGreaterThan(reread)
	})
})

describe('OB-3: rollback_pending retry on the create page', () => {
	it('the rollback_pending reason sets the flag; other reasons clear it', () => {
		expect(src).toContain("setRollbackPending(accepted.code === 'write_failed' && accepted.reason === 'rollback_pending')")
	})

	it('the visibility is checked live (reread and walletStatus) with the rule before the button shows', () => {
		const at = src.indexOf('const visible = createRollbackRetryVisible({')
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at - 500, at)
		expect(block).toContain('readWalletEoaAddress()')
		expect(block).toContain('queryNativeWalletStatusForPreCheck()')
		expect(src.slice(at, at + 220)).toContain("nativeStatus: st")
	})

	it('the button runs the same submit path (the reread runs before any open)', () => {
		expect(src).toContain("onClick={() => void onSubmitPress()}")
		expect(src.indexOf('{rollbackRetryVisible ? (')).toBeGreaterThan(0)
	})
})
