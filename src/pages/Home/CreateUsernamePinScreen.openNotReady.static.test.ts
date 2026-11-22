/**
 * @jest-environment node
 *
 * F-CREATE-1 and OPEN-4: an open ack with reason not_ready shows the retryable try-later text, not the unsupported-version message.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('open ack reason not_ready', () => {
	it('the not_ready open answer shows try-later before the unsupported fallback', () => {
		const at = src.indexOf("if (opened.reason === 'not_ready') {")
		const fallback = src.indexOf("tu('create_account_native_unavailable')", at)
		expect(at).toBeGreaterThan(0)
		expect(src.slice(at, at + 160)).toContain("setCreateError(tu('create_account_try_later'))")
		expect(fallback).toBeGreaterThan(at)
	})
})
