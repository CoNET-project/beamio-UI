/**
 * The text of a blocked feature entry: "please update" only when a valid hello lacks the capability (missing); unanswered or unknown says the wallet is
 * getting ready (late is not dead, 2026-11-24). SYNTHETIC.
 */
import fs from 'fs'
import path from 'path'
import { shellChatBlockedText } from './shellChatCapability'
import { setNativeIdentityCapability } from './nativeIdentityProbeRetry'
import { tu } from '@/locale/beamioLocale'

describe('shellChatBlockedText', () => {
	it('is the update text only for missing', () => {
		setNativeIdentityCapability('missing')
		expect(shellChatBlockedText()).toBe(tu('shell_chat_unavailable_body'))
	})
	it.each(['unknown', 'unanswered', 'present'] as const)('is the preparing text for %s', (state) => {
		setNativeIdentityCapability(state as never)
		expect(shellChatBlockedText()).toBe(tu('native_preparing_wallet'))
		expect(shellChatBlockedText()).not.toBe(tu('shell_chat_unavailable_body'))
	})
	it('no feature entry uses the update text directly any more', () => {
		const root = path.join(__dirname, '..')
		const hits: string[] = []
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const f = path.join(d, e.name)
				if (e.isDirectory()) walk(f)
				else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && fs.readFileSync(f, 'utf8').includes("tu('shell_chat_unavailable_body')")) hits.push(e.name)
			}
		}
		walk(root)
		expect(hits.sort()).toEqual([])
	})
})
