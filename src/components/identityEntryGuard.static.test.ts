/**
 * the chat is an identity entry in a shell without identity.native-keys.v1. Every place that opens the
 * chat page must show the same unavailable notice (ShellChatGate). This test lists the files that open the chat page, so a new one
 * cannot appear unguarded: it fails until the file is added here and wrapped. Reads the source; SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		const st = fs.statSync(full)
		if (st.isDirectory()) walk(full, out)
		else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(full)
	}
	return out
}

/** Files that import the chat page itself (not its sub-components). */
const CHAT_PAGE_IMPORT = /from\s+['"](?:@\/pages\/chat|@\/pages\/chat\/index|\.\.?\/(?:\.\.\/)*pages\/chat(?:\/index)?|\.\/chat)['"]/

describe('identity entries: the chat page is always behind ShellChatGate', () => {
	const importers = walk(SRC)
		// The chat page's own folder is the implementation of the page, not an entry point to it.
		.filter((f) => !path.relative(SRC, f).startsWith(path.join('pages', 'chat') + path.sep))
		.filter((f) => CHAT_PAGE_IMPORT.test(fs.readFileSync(f, 'utf8')))
		.map((f) => path.relative(SRC, f))
		.sort()

	it('the files that open the chat page are the known set', () => {
		expect(importers).toEqual(['App.tsx', 'components/Home/BeamioContactProfilePreview.tsx'].sort())
	})

	it('App.tsx wraps both chat routes in ShellChatGate', () => {
		const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8')
		expect(app).toContain('<Route path="/Chat" element={<ShellChatGate><Chat /></ShellChatGate>} />')
		expect(app).toContain('<Route path="/chat" element={<ShellChatGate><Chat /></ShellChatGate>} />')
	})

	it('the inline chat in the contact preview is wrapped in ShellChatGate', () => {
		const preview = fs.readFileSync(path.join(SRC, 'components', 'Home', 'BeamioContactProfilePreview.tsx'), 'utf8')
		expect(preview).toContain("import { ShellChatGate } from '@/components/ShellChatUnavailableNotice'")
		expect(preview).toMatch(/<ShellChatGate>\s*<ChatHome \/>\s*<\/ShellChatGate>/)
	})
})
