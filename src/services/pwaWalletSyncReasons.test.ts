/**
 * r11 write_failed reasons (plan §七, §八; W-WF-RP, W-WF-OCU, W-REASON-UNK). The four SDK reasons are kept; an unknown reason is
 * internal_state (manual only). The notice gives old_copy_unverified no retry button. Synthetic only.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { mapSyncReply } from './pwaWalletSyncTransport'

describe('write_failed reasons are kept, never silently rewritten', () => {
	it('W-WF-SW and W-WF-IS keep their reason', () => {
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'storage_write' })).toEqual({ code: 'write_failed', reason: 'storage_write' })
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'internal_state' })).toEqual({ code: 'write_failed', reason: 'internal_state' })
	})
	it('W-WF-RP: rollback_pending is kept (not rewritten to internal_state)', () => {
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'rollback_pending' })).toEqual({ code: 'write_failed', reason: 'rollback_pending' })
	})
	it('W-WF-OCU: old_copy_unverified is kept', () => {
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'old_copy_unverified' })).toEqual({ code: 'write_failed', reason: 'old_copy_unverified' })
	})
	it('W-REASON-UNK: an unknown reason falls back to internal_state (manual only)', () => {
		expect(mapSyncReply({ ok: false, error: 'write_failed', reason: 'something_new' })).toEqual({ code: 'write_failed', reason: 'internal_state' })
	})
});

describe('the notice gives old_copy_unverified no retry button', () => {
	const notice = readFileSync(join(__dirname, '..', 'components', 'Home', 'ShellSyncNotice.tsx'), 'utf8')
	it('the old-copy branch returns before the retry button and uses the explanation key only', () => {
		const at = notice.indexOf("const oldCopy = state.code === 'write_failed' && state.reason === 'old_copy_unverified'")
		const btn = notice.indexOf('retryShellSync()')
		expect(at).toBeGreaterThan(0)
		expect(btn).toBeGreaterThan(at)
		expect(notice.slice(at, at + 400)).toMatch(/shell_sync_old_copy_unverified_body/)
	})
});
