/**
 * Message keys and English drafts (design passcode-unified-ui-spec). Copy is PWA-owned; translation pending.
 * Results and message keys are never values: nothing here shows a passcode, a count or an error code.
 */
import { PASSCODE_MAX_DIGITS, PASSCODE_MIN_DIGITS, type PasscodeReason } from './passcodeRules'
import type { FlowMode } from './passcodeFlow'

export const POLICY_TEXT: Record<PasscodeReason, string> = {
	non_digit: 'Use digits only.',
	too_short: `Use ${PASSCODE_MIN_DIGITS} to ${PASSCODE_MAX_DIGITS} digits.`,
	too_long: `Use ${PASSCODE_MIN_DIGITS} to ${PASSCODE_MAX_DIGITS} digits.`,
	all_same: 'Do not use the same digit for every position.',
	repeat_pair: 'Do not repeat a two-digit pattern.',
	common: 'This passcode is too common.',
	sequence: 'Do not use six digits in a row.',
	birthday: 'Do not use a date (birthday-like) passcode.',
}

export const MISMATCH_TEXT = 'The passcodes do not match. Enter the new passcode again.'
export const WRONG_TEXT = 'Wrong passcode. Your data was not changed.'
export const ERROR_TEXT = 'Something went wrong. Your data was not changed.'
export const CONFIRM_FORGET_TEXT = 'Confirm that a forgotten passcode cannot be recovered on this device.'
export const CONFIRM_OFF_TEXT = 'Confirm that you want to turn the passcode off.'

/** Text shown when a run ends (results). */
export const DONE_TEXT: Record<FlowMode, string> = {
	enable: 'Passcode is on.',
	change: 'Passcode changed.',
	disable: 'Passcode is off.',
	unlock: '',
}

/** mm:ss for a cooldown (`{mm:ss}`). */
export function formatCooldown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000))
	return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export const backoffText = (ms: number): string => `Too many wrong attempts. Try again in ${formatCooldown(ms)}.`
