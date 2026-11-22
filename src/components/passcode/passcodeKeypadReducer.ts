/**
 * Pure key handling for the self-drawn passcode keypad (frozen protocol section 〇之一 item 9: no `<input>`).
 * A key is a digit, `delete`, or nothing. The length is capped at the policy maximum; non-digits never enter.
 */
import { PASSCODE_MAX_DIGITS } from '../../services/passcode/passcodeRules'

export type PasscodeKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'delete'

export function applyPasscodeKey(value: string, key: PasscodeKey): string {
	if (key === 'delete') return value.slice(0, -1)
	if (!/^[0-9]$/.test(key)) return value
	if (value.length >= PASSCODE_MAX_DIGITS) return value
	return value + key
}
