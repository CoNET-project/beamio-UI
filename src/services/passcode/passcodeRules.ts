/**
 * Passcode policy for NEW and CHANGED passcodes (decision 2026-11-22, the decision; spec §29 section 2).
 *
 * - a passcode is exactly six ASCII digits (PASSCODE_DIGITS);
 * - refused: all the same digit, a repeated pair (ababab), a common value (PASSCODE_COMMON), a six-digit run (increasing or decreasing);
 * - the 8-digit birthday rule is deleted (it does not apply to six digits);
 * - the policy runs only when a passcode is set or changed. Unlock never applies it (a stored passcode is checked by decryption only).
 *
 * The common list is an engineering default for six digits (the owner has not listed one); it is recorded for confirmation.
 */

export const PASSCODE_DIGITS = 6
/** Kept as aliases for the UI copy: a passcode has exactly PASSCODE_DIGITS digits. */
export const PASSCODE_MIN_DIGITS = PASSCODE_DIGITS
export const PASSCODE_MAX_DIGITS = PASSCODE_DIGITS

/** Six-digit common values (engineering default). */
export const PASSCODE_COMMON: ReadonlySet<string> = new Set([
	'123456',
	'654321',
	'123123',
	'321321',
	'112233',
	'332211',
	'123321',
	'135790',
	'246810',
	'102030',
	'159753',
])

export type PasscodeReason = 'non_digit' | 'too_short' | 'too_long' | 'all_same' | 'repeat_pair' | 'common' | 'sequence'

export type PasscodeCheck = { ok: true } | { ok: false; reason: PasscodeReason }

/** A run of six consecutive digits, all increasing or all decreasing by one. */
function isSixRun(p: string): boolean {
	let up = true
	let down = true
	for (let k = 0; k < p.length - 1; k++) {
		const step = +p[k + 1] - +p[k]
		if (step !== 1) up = false
		if (step !== -1) down = false
	}
	return up || down
}

/** First broken rule, in spec order. Returns ok when the passcode is accepted. Used only when a passcode is set or changed. */
export function checkPasscodePolicy(p: string): PasscodeCheck {
	if (!/^[0-9]*$/.test(p)) return { ok: false, reason: 'non_digit' }
	if (p.length < PASSCODE_DIGITS) return { ok: false, reason: 'too_short' }
	if (p.length > PASSCODE_DIGITS) return { ok: false, reason: 'too_long' }
	if (/^(\d)\1+$/.test(p)) return { ok: false, reason: 'all_same' }
	if (p.slice(0, 2).repeat(3) === p) return { ok: false, reason: 'repeat_pair' }
	if (PASSCODE_COMMON.has(p)) return { ok: false, reason: 'common' }
	if (isSixRun(p)) return { ok: false, reason: 'sequence' }
	return { ok: true }
}
