/**
 * Six-digit passcode policy (unit f3, decision 2026-11-22). Applied only when a passcode is set or changed.
 * SYNTHETIC values only. The 8–12 digit vector list (passcode-vectors.v1.json) and the 8-digit birthday rule are retired.
 */
import { checkPasscodePolicy, PASSCODE_DIGITS } from './passcodeRules'

describe('six-digit policy: accepted and refused (decision 2026-11-22)', () => {
	it('uses exactly six digits', () => {
		expect(PASSCODE_DIGITS).toBe(6)
	})

	it('accepts an ordinary six-digit code', () => {
		expect(checkPasscodePolicy('395784')).toEqual({ ok: true })
		expect(checkPasscodePolicy('802461')).toEqual({ ok: true })
	})

	it('refuses non-digits, and lengths other than six', () => {
		expect(checkPasscodePolicy('39578a')).toEqual({ ok: false, reason: 'non_digit' })
		expect(checkPasscodePolicy('39578')).toEqual({ ok: false, reason: 'too_short' })
		expect(checkPasscodePolicy('3957845')).toEqual({ ok: false, reason: 'too_long' })
		expect(checkPasscodePolicy('12395784')).toEqual({ ok: false, reason: 'too_long' })
	})

	it('refuses all-same digits', () => {
		expect(checkPasscodePolicy('000000')).toEqual({ ok: false, reason: 'all_same' })
		expect(checkPasscodePolicy('777777')).toEqual({ ok: false, reason: 'all_same' })
	})

	it('refuses a repeated pair (ababab)', () => {
		expect(checkPasscodePolicy('121212')).toEqual({ ok: false, reason: 'repeat_pair' })
		expect(checkPasscodePolicy('909090')).toEqual({ ok: false, reason: 'repeat_pair' })
	})

	it('refuses common six-digit values', () => {
		expect(checkPasscodePolicy('135790')).toEqual({ ok: false, reason: 'common' })
		expect(checkPasscodePolicy('159753')).toEqual({ ok: false, reason: 'common' })
	})

	it('refuses a six-digit run, increasing or decreasing', () => {
		expect(checkPasscodePolicy('123456')).toEqual({ ok: false, reason: 'common' }) // common is checked first
		expect(checkPasscodePolicy('234567')).toEqual({ ok: false, reason: 'sequence' })
		expect(checkPasscodePolicy('987654')).toEqual({ ok: false, reason: 'sequence' })
	})

	it('no longer refuses 8-digit birthday-like values (rule deleted); the length check applies instead', () => {
		expect(checkPasscodePolicy('19900315')).toEqual({ ok: false, reason: 'too_long' })
	})
})
