/**
 * @jest-environment node
 *
 * Copy keys of the chat identity notices are the chat.* set. The old pgp_* and
 * shell_identity_retry_* keys are internal and are not shown. Reads source and locale only; no key material.
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('chat identity copy keys', () => {
	it('the failure notice and the retry line use chat.* keys only', () => {
		const src = read('components/PgpRestoreFailedNotice.tsx')
		// the not_ready failure picks its own keys through a ternary; the other failures keep theirs.
		expect(src).toContain("'chat.restore_failed.body'")
		expect(src).toContain("'chat.restore_failed.entry'")
		expect(src).toMatch(/tu\('chat\.restore_retry\.body'\)/)
		expect(src).not.toMatch(/tu\('pgp_|tu\(REASON_KEYS/)
	})

	it('the shell retry notice uses the chat.* retry key', () => {
		const src = read('components/ShellChatUnavailableNotice.tsx')
		expect(src).toMatch(/tu\('chat\.restore_retry\.body'\)/)
		expect(src).not.toMatch(/shell_identity_retry_/)
	})

	it('the locale has the chat.* keys in both languages, and none of the retired keys', () => {
		for (const f of ['locale/en.json', 'locale/zh-CN.json']) {
			const ui = (JSON.parse(read(f)) as { ui: Record<string, string> }).ui
			for (const k of ['chat.restore_failed.body', 'chat.restore_failed.entry', 'chat.restore_retry.body']) {
				expect(typeof ui[k]).toBe('string')
			}
			const retired = Object.keys(ui).filter((k) => /^(pgp_regen_|pgp_restore_failed_|pgp_restore_generate_|shell_identity_retry_)/.test(k))
			expect(retired).toEqual([])
		}
	})
})
