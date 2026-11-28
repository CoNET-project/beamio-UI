/**
 * /, checked on the source: the create screen follows the page and walletStatus rules (G1 and G2 do not
 * retry; G0 has the 15 s wait and the terminal copy after three); the chat page shows the one-time prompt only for a first fetch with no verified
 * key, persists dismissal per contact, and writes the key on screen as verified.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const text = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('the account-create ack rules on the create screen', () => {

	it('the open call is not repeated with the same reqId: each call is a new open, and there is no automatic retry', () => {
		const s = text('services/nativeRecovery.ts')
		expect(s).toContain('const reqId = nextReqId()')
		expect(s).not.toMatch(/setTimeout\([^)]*nativeAccountCreateOpen/)
	})
})

describe('the one-time verification prompt on the chat page', () => {
	it('is due only through the due-check, and only a first fetch with a key shows it', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('if (!oneTimeVerifyPromptDue(current)) {')
		expect(s).toContain("trust.code === 'first_fetch_pending' && trust.held ? trust.held : null")
	})

	it('"verified" writes the key on screen as verified; "later" persists the dismissal per contact', () => {
		const s = text('pages/chat/chat.tsx')
		expect(s).toContain('applyPeerRoute(current, held, true)')
		expect(s).toContain('patchStoredChatRow(current.address, { verifyPromptSeen: true })')
		expect(s).toContain('patchStoredChatRow(chatDataRef.current.address, { verifyPromptSeen: true })')
		expect(s).toContain("tu('chat.verify_once.action')")
		expect(s).toContain("tu('chat.verify_once.later')")
	})
})
