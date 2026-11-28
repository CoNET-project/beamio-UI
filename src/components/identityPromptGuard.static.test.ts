// the guard on the native-wallet-not-ready prompt: a live chat means the native side is ready, so the prompt is not shown.
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'IdentityEntryPrompt.tsx'), 'utf8')

describe('IdentityEntryPrompt guard', () => {
	it('a live chat is never shown the "not ready" prompt: the raise is ignored, an open prompt closes by itself, and nothing renders while the chat is live', () => {
		expect(src).toMatch(/if \(isShellChatLive\(\)\) \{ firstBlockedAtRef\.current = null; return \}\s*setMode\(/)
		expect(src).toMatch(/if \(isShellChatLive\(\)\) \{ firstBlockedAtRef\.current = null; return \}\s*const now = Date\.now\(\)/)
		expect(src).toMatch(/if \(isShellChatLive\(\)\) setOpen\(false\)/)
		// the dialog is never rendered while the chat is live (only the short "ready" status may be)
		expect(src).toMatch(/const live = isShellChatLive\(\)/)
		expect(src).toMatch(/if \(!open \|\| live\) return status/)
		expect(src).toMatch(/import \{ isShellChatLive \} from '..\/services\/shellChatLive'/)
	})
})
