/**
 * /, checked on the source (SYNTHETIC; no values): the create screen follows the page and walletStatus rules (G1 and G2 do not
 * retry; G0 has the 15 s wait and the terminal copy after three); the chat page shows the one-time prompt only for a first fetch with no verified
 * key, persists dismissal per contact, and writes the key on screen as verified.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')
const text = (f: string) => readFileSync(join(SRC, f), 'utf8')

describe('the account-create ack rules on the create screen', () => {
	it('G1 and G2 show the unavailable copy and do not set a cooldown', () => {
		const s = text('pages/Home/CreateUsernamePinScreen.tsx')
		expect(s).toContain("if (opened.walletStatus === 'G1' || opened.walletStatus === 'G2') {")
		expect(s).toContain("setCreateError(tu('create_account_unavailable'))")
	})

	it('G0 waits 15 s before a manual retry, and three in a row show the terminal copy', () => {
		const s = text('pages/Home/CreateUsernamePinScreen.tsx')
		expect(s).toContain('createCooldownUntilRef.current = Date.now() + 15_000')
		expect(s).toContain('if (Date.now() < createCooldownUntilRef.current) {')
		expect(s).toContain("tu('create_account_unavailable_terminal')")
		expect(s).toMatch(/g0NotAvailableCountRef\.current >= 3/)
	})

	it('page "opened" shows the opening state; any other page value waits for the result event', () => {
		const s = text('pages/Home/CreateUsernamePinScreen.tsx')
		expect(s).toContain("if (opened.page === 'opened') {")
		expect(s).toContain('setNativeOpening(true)')
		expect(s).toContain("tu('create_account_opening')")
		expect(s).toContain('waiting for the result event')
	})

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
