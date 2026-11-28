/**
 * @jest-environment node
 *
 * Static checks for  the first identity has an entry that only starts the native click, the retry copy is shown
 * instead of a failure line, and the gate shows the entry for the first-identity state. SYNTHETIC; reads source only.
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

describe('first identity entry', () => {
	it('the entry uses the native generate call, and the retry copy is the one shown when it is not done', () => {
		const src = read('components/PgpFirstIdentityNotice.tsx')
		expect(src).toMatch(/nativeGenerateNewPgpKey\(shellAccountKeyOrEmpty\(\)\)/)
		// 0.53.52: the failure line names its reason (pgpCreateFailureCopyKey); "Can't read…" is not the line for a create that did not happen
		expect(src).toMatch(/pgpCreateFailureCopyKey\(result\.reason\)/)
		expect(src).not.toMatch(/tu\('chat\.restore_retry\.body'\)/)
		expect(src).toMatch(/PGP_IDENTITY_CREATE_ENABLED && pgpCreateEligible/)
		expect(src).toMatch(/tu\('chat\.first_identity\.entry'\)/)
		expect(src).not.toMatch(/pgp_restore_failed|chat\.restore_failed/)
	})

	it('the gate shows the first-identity entry', () => {
		const src = read('components/ShellChatUnavailableNotice.tsx')
		expect(src).toMatch(/if \(firstIdentity\) return <PgpFirstIdentityNotice \/>/)
	})

	it('the locale has the chat.* keys in both languages', () => {
		for (const f of ['locale/en.json', 'locale/zh-CN.json']) {
			const j = JSON.parse(read(f)) as { ui: Record<string, string> }
			for (const k of ['chat.first_identity.body', 'chat.first_identity.entry', 'chat.restore_retry.body']) {
				expect(typeof j.ui[k]).toBe('string')
			}
		}
	})
})
