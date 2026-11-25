/**
 * H1: every copy key the recovery and import pages use resolves to its text in en and zh-CN through the real `tu`, never to a raw
 * key (the `ui.` form is tried first, then the key as written). Real i18n instance; no mocks.
 */
import i18next from 'i18next'
import { tu } from '@/locale/beamioLocale'
import { nativeRecoveryCopyKey, recoveryOpenErrorKey } from '@/services/nativeRecovery'

const OPEN_REASONS = ['not_supported', 'not_available', 'bad_request', 'key_over_bridge_refused', 'timeout', 'capability_missing', 'untrusted_origin', 'origin_refused']
const NATIVE_CODES = ['legacy_record', 'not_ready', 'unregister_refused', 'busy', 'clear_failed', 'main_thread', 'unknown', 'bad_pin', 'backoff', 'not_found', 'network_error', 'already_exists', 'record_invalid', 'write_failed', 'readback_failed', 'invalid_format']

function keysUnderTest(): string[] {
	const keys = new Set<string>()
	for (const reason of OPEN_REASONS) keys.add(recoveryOpenErrorKey(reason))
	for (const code of NATIVE_CODES) {
		const key = nativeRecoveryCopyKey(code)
		if (key) keys.add(key)
	}
	return [...keys]
}

describe.each(['en', 'zh-CN'])('recovery and import copy resolves through tu (%s)', (lng) => {
	beforeAll(async () => {
		await i18next.changeLanguage(lng)
	})

	it('every key used by recoveryOpenErrorKey and nativeRecoveryCopyKey shows text, not the key', () => {
		const keys = keysUnderTest()
		expect(keys.length).toBeGreaterThanOrEqual(6)
		for (const key of keys) {
			const out = tu(key)
			expect(out).not.toBe(key)
			expect(out).not.toBe(`ui.${key}`)
			expect(out.trim().length).toBeGreaterThan(0)
		}
	})

	it('the retry label and the backoff seconds resolve', () => {
		expect(tu('recovery.native.retry')).not.toBe('recovery.native.retry')
		const out = tu('recovery.native.backoff', { seconds: 7 })
		expect(out).toContain('7')
	})

	it('the generic restore failure key (kept under ui) shows its text', () => {
		const out = tu(recoveryOpenErrorKey('bad_request'))
		expect(out).not.toBe('something_went_wrong_while_restoring_your_wallet')
		expect(out).not.toBe('ui.something_went_wrong_while_restoring_your_wallet')
	})

	it('a top-level key still resolves as written, and a ui key resolves under ui', () => {
		expect(tu('import.unregister_refused')).not.toBe('import.unregister_refused')
		expect(tu('ui.something_went_wrong_while_restoring_your_wallet')).not.toBe('ui.something_went_wrong_while_restoring_your_wallet')
	})
})
