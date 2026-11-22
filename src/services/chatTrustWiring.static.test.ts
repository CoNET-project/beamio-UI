/**
 * BCHAT 36: static wiring of the chat page's trust path. The page cannot run in jest; these checks pin the sequence the end-to-end test
 * (heldSendTrust.e2e.test.ts) models, and the removal of the in-place writes that hid the trust from the stored row.
 */
import fs from 'fs'
import path from 'path'

const chatSource = fs.readFileSync(path.join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')

function bodyOf(name: string): string {
	const start = chatSource.indexOf(`function ${name}(`) >= 0 ? chatSource.indexOf(`function ${name}(`) : chatSource.indexOf(`async function ${name}(`)
	expect(start).toBeGreaterThan(-1)
	const next = chatSource.indexOf('\n\tfunction ', start + 10)
	const nextAsync = chatSource.indexOf('\n\tasync function ', start + 10)
	const candidates = [next, nextAsync].filter((i) => i > start)
	const end = candidates.length ? Math.min(...candidates) : chatSource.length
	return chatSource.slice(start, end)
}

describe('chat page trust path', () => {
	it('applyPeerRoute builds the new chatData, compares with the object before the write, and writes the rows', () => {
		const body = bodyOf('applyPeerRoute')
		const order = ['nextPeerChatData(before', 'routeFieldsDiffer(before, next)', 'applyPeerRouteToRows(']
		const at = order.map((s) => body.indexOf(s))
		expect(at.every((i) => i > -1)).toBe(true)
		expect(at[0]).toBeLessThan(at[1])
		expect(at[1]).toBeLessThan(at[2])
	})

	it('the page no longer writes the trust fields in place', () => {
		expect(chatSource).not.toMatch(/cd\.verifiedFingerprint\s*=/)
		expect(chatSource).not.toMatch(/cd\.keyFingerprint\s*=/)
		expect(chatSource).not.toMatch(/cd\.publicArmored\s*=/)
	})

	it('"Verified, continue" writes the trust through applyPeerRoute, then sends the held messages again', () => {
		const body = bodyOf('confirmVerifyPrompt')
		expect(body).toMatch(/applyPeerRoute\(current, held, true\)/)
		expect(body).toMatch(/resendHeldAfterTrust\(\)/)
	})

	it('the held messages are read again (fresh) after the verification; no pinned key is reused from memory', () => {
		const body = bodyOf('resendHeldAfterTrust')
		expect(body).toMatch(/retryHeldSend\(id, 'fresh'\)/)
	})

	it('retryHeldSend rebuilds a held text from the stored message; without a key in memory a send is fresh and never trusts', () => {
		const body = bodyOf('retryHeldSend')
		expect(body).toMatch(/heldRecordFromMessage\(tempId\)/)
		expect(body).toMatch(/wantsPinned && !pinned \? 'fresh' : mode/)
		expect(body).not.toMatch(/sendWithExpectedRoute|expectedFingerprint/)
	})

	it('a held first contact after a fresh read opens the verify panel, and the panel is the only place that writes the trust after a reload', () => {
		const body = bodyOf('retryHeldSend')
		expect(body).toMatch(/setVerifyPrompt\(heldKey\)/)
		const confirm = bodyOf('confirmVerifyPrompt')
		expect(confirm).toMatch(/const saved = await applyPeerRoute\(current, held, true\)/)
		expect(confirm).toMatch(/if \(saved\) await resendHeldAfterTrust\(\)/)
	})

	it('a failed save of a trust write is reported, not silent', () => {
		const body = bodyOf('applyPeerRoute')
		expect(body).toMatch(/persisted = storeSystemDataAndWait\(\)/)
		expect(body).toMatch(/if \(!saved\) setChatError/)
	})

	it('the QA readback of the stored row is only read in a trace build', () => {
		expect(chatSource).toMatch(/process\.env\.REACT_APP_BEAMIO_BOOT_TRACE === 'true'\) \{\s*\/\/ QA only/)
		expect(chatSource).toMatch(/recordVerifyTrace\('trust-readback'/)
	})

	it('the QA trace records the calls (no key material in the fields)', () => {
		expect(chatSource).toMatch(/recordVerifyTrace\('verify-confirm'/)
		expect(chatSource).toMatch(/recordVerifyTrace\('trust-write'/)
		expect(chatSource).toMatch(/recordVerifyTrace\('held-retry'/)
	})
})
