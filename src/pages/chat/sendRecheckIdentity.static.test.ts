/**
 * Send re-check (S-02..S-07). Source checks: chat.tsx cannot be mounted under jest.
 * SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const chat = fs.readFileSync(path.join(__dirname, 'chat.tsx'), 'utf8')
const svc = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'chat.ts'), 'utf8')
const idp = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'nativeIdentityPublic.ts'), 'utf8')
const sendBody = chat.slice(chat.indexOf('async function send() {'), chat.indexOf('async function deliverText('))

describe('send in a shell without entry nodes (S-02, S-03, S-07)', () => {
	it('the text send never marks Failed by itself in a shell: it waits for the chat start (S-07)', () => {
		const i = sendBody.indexOf('if (!allNodes?.length) {')
		expect(i).toBeGreaterThan(0)
		const branch = sendBody.slice(i, sendBody.indexOf('await deliverText(', i))
		expect(branch.indexOf('if (isShellContext())')).toBeGreaterThan(-1)
		expect(branch.indexOf('waitSendForNodes(')).toBeGreaterThan(branch.indexOf('if (isShellContext())'))
		// the only "failed" in that branch sits after the shell return (the browser path)
		expect(branch.indexOf('"failed"')).toBeGreaterThan(branch.indexOf('return'))
	})
	it('the wait asks for one start (single flight) and the nodes arriving send it without a second tap (S-02, S-03)', () => {
		expect(chat).toContain('askShellChatStartForSend()')
		expect(chat).toMatch(/useEffect\(\(\) => \{\s*if \(!allNodes\?\.length \|\| nodeWaitSendsRef\.current\.size === 0\) return/)
		expect(chat).toContain('deliverTextRef.current(id, w.wire, w.t0)')
	})
	it('the window is 180 s and ends as a retryable not-sent with the content kept (S-04)', () => {
		expect(chat).toContain('SEND_NODE_WAIT_WINDOW_MS = 180_000')
		expect(chat).toContain("sendError: 'identity_not_ready'")
	})
	it('the start asked for by a send is single flight and has no count cap', () => {
		const f = svc.slice(svc.indexOf('export function askShellChatStartForSend'), svc.indexOf('export function restartShellChatAfterMigrationRetry'))
		expect(f).toContain('initChatInProgress')
		expect(f).toContain("lastShellStartResult === 'started'")
		expect(f).not.toMatch(/Cap|count/)
	})
})

describe('not_ready is never cached as a fact (S-05)', () => {
	it('the identityPublic read keeps no cached not_ready', () => {
		expect(idp).not.toMatch(/let\s+\w*(cache|last)\w*\s*[:=][^\n]*not_ready/i)
		expect(idp).not.toMatch(/cachedNotReady/i)
	})
})

describe('reactions, cancel and file sends (the same rule)', () => {
	it('none of them fails or returns at once on an empty allNodes: each waits for the chat start first', () => {
		const react = chat.slice(chat.indexOf('async function sendReaction('), chat.indexOf('async function sendPaymentRequestCancel('))
		expect(react).toContain('waitNodesForAction(SEND_ACTION_WAIT_MS)')
		expect(react).not.toContain('if (!allNodes?.length)')
		const cancel = chat.slice(chat.indexOf('async function sendPaymentRequestCancel('), chat.indexOf('async function executePaymentRequestTransfer('))
		expect(cancel).toContain('waitNodesForAction(SEND_ACTION_WAIT_MS)')
		expect(cancel).not.toContain('if (!allNodes?.length)')
		const files = chat.slice(chat.indexOf('const sendFileDrafts = useCallback'), chat.indexOf('}, [allNodes, chatData, fileJobs, privateKey])'))
		expect(files).toContain('waitNodesForAction(SEND_ACTION_WAIT_MS)')
		expect(files).not.toContain('!allNodes?.length')
	})
	it('the send to the recipient reads the nodes at send time, not the stale render value', () => {
		const f = chat.slice(chat.indexOf('async function sendChatToRecipient('), chat.indexOf('lastSendHeldRef.current = result.ok'))
		expect(f).toContain('allNodesRef.current')
		expect(f).not.toMatch(/\ballNodes \?\? \[\]/)
	})
	it('the wait is 45 s and only a shell waits', () => {
		expect(chat).toContain('SEND_ACTION_WAIT_MS = 45_000')
		expect(chat).toContain('if (!isShellContext()) return false')
	})
})

describe('the quote draft (browser behaviour as before)', () => {
	it('is cleared only once the send is accepted: not before the no-nodes check', () => {
		const at = sendBody.indexOf('if (!allNodes?.length) {')
		const before = sendBody.slice(0, at)
		expect(before).not.toContain('setReplyTo(null)')
		// a shell that waits for the chat start has accepted the send; a browser without nodes fails and keeps the draft
		const waitBranch = sendBody.slice(at, sendBody.indexOf('waitSendForNodes('))
		expect(waitBranch).toContain('setReplyTo(null)')
		const browserFail = sendBody.slice(sendBody.indexOf('waitSendForNodes('), sendBody.indexOf('await deliverText('))
		expect(browserFail.indexOf('"failed"')).toBeGreaterThan(0)
		expect(browserFail.slice(0, browserFail.indexOf('return\n\t\t}'))).not.toContain('setReplyTo(null)')
		expect(sendBody.slice(sendBody.indexOf('await deliverText(') - 160, sendBody.indexOf('await deliverText('))).toContain('setReplyTo(null)')
	})
})
