/** 0.53.52: one reason, one copy; "Can't read your Chat identity" only for a real read failure. SYNTHETIC. */
import { createNeverSends, pgpCreateFailureCopyKey } from './pgpCreateFailureCopy'
import i18next from 'i18next'
import { tu } from '../locale/beamioLocale'

describe('the failure copy by reason', () => {
	it.each([
		['native_unavailable', 'chat.create_unavailable.body'],
		['timeout', 'chat.create_timeout.body'],
		['locked', 'chat.create_locked.body'],
		['origin_refused', 'chat.create_refused.body'],
		['not_available', 'chat.create_refused.body'],
		['pending_exists', 'chat.create_refused.body'],
		['read_failed', 'chat.restore_retry.body'],
		['not_ready', 'chat.restore_retry.body'],
		[undefined, 'chat.create_retry.body'],
		['', 'chat.create_retry.body'],
	])('%s -> %s', (reason, key) => {
		expect(pgpCreateFailureCopyKey(reason as string | undefined)).toBe(key)
	})
	it.each(['not_enabled', 'not_eligible', 'no_account'])('%s: no failure line, and the page knows before any click that nothing would be sent', (reason) => {
		expect(pgpCreateFailureCopyKey(reason)).toBeNull()
		expect(createNeverSends(reason)).toBe(true)
	})
	it('the other reasons are not "never sends"', () => {
		for (const r of ['native_unavailable', 'timeout', 'locked', 'whatever', undefined]) expect(createNeverSends(r as string | undefined)).toBe(false)
	})
	it('only a real read failure may show "Can\'t read your Chat identity"', () => {
		const readKey = 'chat.restore_retry.body'
		for (const r of ['native_unavailable', 'timeout', 'locked', 'origin_refused', 'x', undefined, 'not_enabled']) {
			expect(pgpCreateFailureCopyKey(r as string | undefined)).not.toBe(readKey)
		}
	})
	it('every key resolves to real text in both language packs (en, zh-CN) through tu, and the failed notice says the next start retries', async () => {
		const keys = ['chat.create_unavailable.body', 'chat.create_timeout.body', 'chat.create_locked.body', 'chat.create_refused.body', 'chat.create_retry.body', 'chat.first_identity_failed.body']
		for (const lang of ['en', 'zh-CN']) {
			await i18next.changeLanguage(lang)
			for (const k of keys) {
				const v = tu(k)
				expect(v).not.toBe(k)
				expect(v).not.toMatch(/^(ui\.)?chat\./)
				expect(v.length).toBeGreaterThan(0)
			}
		}
		await i18next.changeLanguage('en')
		expect(tu('chat.first_identity_failed.body')).toMatch(/next time the app starts/)
		await i18next.changeLanguage('zh-CN')
		expect(tu('chat.first_identity_failed.body')).toMatch(/下次启动/)
		await i18next.changeLanguage('en')
	})
})
