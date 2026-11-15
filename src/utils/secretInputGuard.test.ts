/**
 * @jest-environment node
 *
 * The secret-field guard (2026-11-13, iOS VoiceOver paste test): what the page can remove from a secret field.
 */
import { secretFieldProps } from './secretInputGuard'

const fakeEvent = () => {
	const e = { prevented: false, preventDefault() { e.prevented = true } }
	return e
}

describe('secretFieldProps', () => {
	it.each(['pin', 'secret'] as const)('%s: no autofill, spelling, autocorrect, capitalisation or password-manager capture', (kind) => {
		const p = secretFieldProps(kind)
		expect(p.autoComplete).toBe('off')
		expect(p.autoCorrect).toBe('off')
		expect(p.autoCapitalize).toBe('none')
		expect(p.spellCheck).toBe(false)
		expect(p['data-form-type']).toBe('other')
		expect(p['data-lpignore']).toBe('true')
		expect(p['data-1p-ignore']).toBe('true')
	})

	it.each(['pin', 'secret'] as const)('%s: copy, cut and drop out of the field are blocked', (kind) => {
		const p = secretFieldProps(kind)
		for (const handler of [p.onCopy, p.onCut, p.onDrop]) {
			const e = fakeEvent()
			handler?.(e)
			expect(e.prevented).toBe(true)
		}
	})

	it('pin: paste is blocked (digits are typed)', () => {
		const p = secretFieldProps('pin')
		const e = fakeEvent()
		p.onPaste?.(e)
		expect(e.prevented).toBe(true)
	})

	it('secret: paste is left to the browser (a recovery code or password may be pasted in a browser)', () => {
		expect(secretFieldProps('secret').onPaste).toBeUndefined()
	})

	it('returns a fresh object each call (no shared mutable state)', () => {
		const a = secretFieldProps('pin')
		a.autoComplete = 'on'
		expect(secretFieldProps('pin').autoComplete).toBe('off')
	})
})
