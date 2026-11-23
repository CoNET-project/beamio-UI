/**
 * Static pin of the BCHAT 40 (R87) wiring in chat.tsx: the send gate reads the stored trust, and a verify press with no key on screen
 * opens the panel before any send. Mutations of these lines must fail here.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const chat = readFileSync(join(__dirname, '..', 'pages', 'chat', 'chat.tsx'), 'utf8')

function bodyOf(name: string): string {
	const i = chat.indexOf(name)
	if (i < 0) return ''
	return chat.slice(i, i + 2200)
}

describe('chat page wiring of the stored-trust gate (BCHAT 40)', () => {
	it('the fresh and the cached send gates take the stored-trust copy, never the memory copy', () => {
		const send = bodyOf('async function sendChatToRecipient(')
		expect(send).toContain('sendWithFreshRoute(await trustGateCopy(current)')
		expect(send).toContain('sendViaCachedRoute(await trustGateCopy(current)')
		expect(send).not.toContain('sendWithFreshRoute(current,')
	})

	it('a verify or accept press with no pinned key reads once and opens the panel before any send', () => {
		const retry = bodyOf('async function retryHeldSend(')
		const guard = retry.indexOf("(mode === 'verify' || mode === 'accept')")
		const send = retry.indexOf('sendChatToRecipient(held.text')
		expect(guard).toBeGreaterThan(0)
		expect(retry.slice(guard, send)).toContain('setVerifyPrompt(trust.held)')
		expect(retry.slice(guard, send)).toContain('return')
	})

	it('trustGateCopy returns the helper with the stored value (the memory copy is never the gate)', () => {
		const gate = bodyOf('async function trustGateCopy(')
		expect(gate).toContain('gateCopyWithStore(current, stored, memVerifiedWriterRef.current)')
		expect(gate).not.toMatch(/return current\b/)
	})

	it('the gate writes a QA trace with booleans only (memory, stored, writer)', () => {
		const gate = bodyOf('async function trustGateCopy(')
		expect(gate).toContain("recordVerifyTrace('trust-gate', trace)")
	})

	it('the resend after "Verified, continue" waits for the saved trust (guard pinned; removing it must fail)', () => {
		const confirm = bodyOf('async function confirmVerifyPrompt(')
		expect(confirm).toContain('const saved = await applyPeerRoute(current, held, true)')
		expect(confirm).toContain('if (saved) await resendHeldAfterTrust()')
	})
})
