/**
 * the chat copy keys resolve to their text through `tu`. The locale files keep every copy key under `ui`, dotted keys
 * included, so `tu` looks each key up under `ui.` (before the fix, chat.retry_exhausted.body showed as the raw key on the device).
 * Real i18n instance and the real `tu`; no mocks.
 */
import i18next from 'i18next'
import { tu } from '@/locale/beamioLocale'
import en from './en.json'

const KEYS = [
	'chat.clear_confirm.body',
	'chat.clear_confirm.ok',
	'chat.clear_failed.body',
	'chat.clear_failed.entry',
	'chat.clear_refused.body',
	'chat.first_identity.body',
	'chat.first_identity.entry',
	'chat.import_retry.entry',
	'chat.replace_not_supported',
	'chat.restore_retry.body',
	'chat.retry_exhausted.body',
]

describe('chat copy keys resolve through tu', () => {
	beforeAll(async () => {
		await i18next.changeLanguage('en')
	})

	it('the retry_exhausted body shows its copy, not the raw key', () => {
		expect(tu('chat.retry_exhausted.body')).toBe("Chat couldn't connect several times, so automatic retries have stopped.")
	})

	for (const k of KEYS) {
		it(`tu('${k}') resolves to text`, () => {
			const v = tu(k)
			expect(v).not.toBe(k)
			expect(v.length).toBeGreaterThan(0)
		})
	}

	it('the short form and the ui. form of a plain key still resolve', () => {
		expect(tu('shell_chat_unavailable_title')).toBe('Chat is unavailable')
		expect(tu('ui.shell_chat_unavailable_title')).toBe('Chat is unavailable')
	})

	it('a top-level section key (import.*) is used as written, not under ui (review H1)', () => {
		expect(tu('import.unregister_refused')).toBe((en as any).import.unregister_refused)
		expect(tu('import.unregister_refused')).not.toBe('ui.import.unregister_refused')
	})
})
