/**
 * (a), in a shell the mailbox probe is not stopped before the native command by a page key check. The chat page's
 * probe effect and the tag refresh only require a page key in a browser. The probe itself then goes through mailboxProbeSign.
 * Reads the source; SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const chatPage = fs.readFileSync(path.join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')
const tagRefresh = fs.readFileSync(path.join(__dirname, 'beamioTagMailboxRefresh.ts'), 'utf8')

describe('the shell probe is not stopped by a page key', () => {
	it('the chat page probe effect requires a page key in a browser only', () => {
		expect(chatPage).toContain('if (!addr || !route || !probeHasSigner(isShellContext(), key)) return')
		expect(chatPage).not.toContain('if (!addr || !route || !key) return')
		expect(chatPage).toContain("import { probeHasSigner } from '@/services/mailboxProbeSigning'")
		expect(chatPage).toContain("import { isShellContext } from '@/services/shellContext'")
	})

	it('the tag refresh needs a page key in a browser only, for both the online and the wake probe', () => {
		expect(tagRefresh).toContain('const shell = isShellContext()')
		expect(tagRefresh).toContain('const signable = probeHasSigner(shell, key)')
		expect(tagRefresh.split('signable && !!route').length - 1).toBe(2)
		expect(tagRefresh).toContain('if (!signable || !route) continue')
		expect(tagRefresh).not.toContain('!!key && !!route')
		expect(tagRefresh).not.toContain('if (!key || !route) continue')
	})

	it('the browser probe keeps its page key path: the key is still passed to the probe functions', () => {
		expect(tagRefresh).toContain('refreshPeerNativeWakeable(addr, route, key)')
		expect(chatPage).toContain('refreshPeerNativeWakeable(addr, route, key)')
	})
})
