/**
 * the not_ready failure of the PGP restore has its own failure code, copy keys (both locales) and a notice
 * that offers the explicit replacement. Source-level checks; the notice itself is covered by the render tests where present.
 */
import fs from 'fs'
import path from 'path'
import { PGP_RESTORE_FAILURES, isPgpRestoreFailure } from './pgpRestore'
import en from '../locale/en.json'
import zh from '../locale/zh-CN.json'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('pgp restore not_ready', () => {
	it('the failure code is in the list and accepted by the guard', () => {
		expect(PGP_RESTORE_FAILURES).toContain('pgp_restore_not_ready')
		expect(isPgpRestoreFailure('pgp_restore_not_ready')).toBe(true)
	})
	it('the notice picks its own copy for not_ready and keeps the old copy for the other failures', () => {
		const notice = read('components/PgpRestoreFailedNotice.tsx')
		expect(notice).toContain("'chat.restore_not_ready.body' : 'chat.restore_failed.body'")
		expect(notice).toContain("'chat.restore_failed.entry' : 'chat.restore_generate.entry'")  // not_ready uses the spec key; classes 1-3 keep their text
	})
	it('both locales carry the not_ready copy keys', () => {
		for (const locale of [en as any, zh as any]) {
			expect(typeof locale.ui['chat.restore_not_ready.body']).toBe('string')
			expect(locale.ui['chat.restore_not_ready.entry']).toBeUndefined()  // the entry uses chat.restore_failed.entry
			expect(typeof locale.ui['chat.restore_generate.entry']).toBe('string')
			expect(typeof locale.ui['chat.restore_failed.entry']).toBe('string')
		}
	})
	it('a browser never generates from the not_ready notice (fails closed before regeneratePgpKeyByUser)', () => {
		const notice = read('components/PgpRestoreFailedNotice.tsx')
		const guard = notice.indexOf("_code === 'pgp_restore_not_ready' && !isShellContext()")
		const generate = notice.indexOf('regeneratePgpKeyByUser()')
		expect(guard).toBeGreaterThan(0)
		expect(generate).toBeGreaterThan(guard)
	})

	it('the shell start ends on already_exists and not_ready, and only other codes retry', () => {
		const start = read('services/shellChatStart.ts')
		expect(start).toContain("if (r.code === 'not_ready') {")
		expect(start).toContain("deps.showPgpFailure('pgp_restore_not_ready')")
		const tail = start.slice(start.indexOf("if (r.code === 'not_ready') {"))
		expect(tail.indexOf('deps.retry(`pgp restore ${r.code}`)')).toBeGreaterThan(tail.indexOf("deps.showPgpFailure('pgp_restore_not_ready')"))
	})

	it('the replacement not_supported notice and its locale key exist in both locales', () => {
		const notice = read('components/PgpRestoreFailedNotice.tsx')
		expect(notice).toContain("generateAnswerOutcome(result)")
		expect(notice).toContain("outcome === 'unsupported'")
		expect(notice).toContain("tu('chat.replace_not_supported')")
		expect(typeof (en as any).ui['chat.replace_not_supported']).toBe('string')
		expect(typeof (zh as any).ui['chat.replace_not_supported']).toBe('string')
	})
})
