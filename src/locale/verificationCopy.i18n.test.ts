/**
 * every copy key added for the account-create rules (G0, G1, G2, the terminal state, the opening state) and for the one-time
 * verification prompt exists in both locale files, with text. The copy is a draft pending the owner's confirmation.
 */
import en from './en.json'
import zh from './zh-CN.json'

const KEYS = [
	'create_account_opening',
	'create_account_unavailable',
	'create_account_unavailable_terminal',
	'create_account_close_native_first',
	'create_account_try_later',
	'chat.verify_once.title',
	'chat.verify_once.body',
	'chat.verify_once.hint',
	'chat.verify_once.action',
	'chat.verify_once.later',
]

describe('copy keys for the rules and the one-time verification prompt', () => {
	it.each(KEYS)('%s exists in en and zh-CN with text', (key) => {
		const e = (en as { ui: Record<string, string> }).ui[key]
		const z = (zh as { ui: Record<string, string> }).ui[key]
		expect(typeof e).toBe('string')
		expect(e.trim().length).toBeGreaterThan(0)
		expect(typeof z).toBe('string')
		expect(z.trim().length).toBeGreaterThan(0)
	})
})
