/**
 * Passcode policy and backoff (shared vectors: passcode-vectors.v1.json, copied to this folder).
 *
 * Rules are the spec's, with one  on top (2026-11-11): 8-digit birthday-like values are refused
 * (YYYYMMDD with 1900–2099, MMDDYYYY and DDMMYYYY with a valid date). The vector file still lists 20251231 as valid;
 * the interface owner is updating it. The test keeps that single case explicit until then.
 */

export const PASSCODE_MIN_DIGITS = 8
export const PASSCODE_MAX_DIGITS = 12

/** Common-list values, exactly as in the vector file (policy.common). */
export const PASSCODE_COMMON: ReadonlySet<string> = new Set([
	'00000000',
	'11111111',
	'12345678',
	'87654321',
	'12341234',
	'12121212',
	'20202020',
	'10101010',
	'13131313',
	'11223344',
])

export type PasscodeReason =
	| 'non_digit'
	| 'too_short'
	| 'too_long'
	| 'all_same'
	| 'repeat_pair'
	| 'common'
	| 'sequence'
	| 'birthday'

export type PasscodeCheck = { ok: true } | { ok: false; reason: PasscodeReason }

const validDate = (y: number, m: number, d: number): boolean => {
	if (m < 1 || m > 12 || d < 1) return false
	const dim = new Date(Date.UTC(y, m, 0)).getUTCDate()
	return d <= dim
}

/** 8-digit birthday-like: YYYYMMDD, MMDDYYYY, DDMMYYYY. Years 1900–2099 only, valid calendar dates only. */
export function isBirthdayLike8(p: string): boolean {
	if (p.length !== 8) return false
	const yyyyMmDd = +p.slice(0, 4) >= 1900 && +p.slice(0, 4) <= 2099 && validDate(+p.slice(0, 4), +p.slice(4, 6), +p.slice(6, 8))
	const y2 = +p.slice(4, 8)
	const y2ok = y2 >= 1900 && y2 <= 2099
	const mmDdYyyy = y2ok && validDate(y2, +p.slice(0, 2), +p.slice(2, 4))
	const ddMmYyyy = y2ok && validDate(y2, +p.slice(2, 4), +p.slice(0, 2))
	return yyyyMmDd || mmDdYyyy || ddMmYyyy
}

/** A run of six consecutive digits, all increasing or all decreasing by one. */
function hasSixRun(p: string): boolean {
	for (let i = 0; i + 6 <= p.length; i++) {
		let up = true
		let down = true
		for (let k = 0; k < 5; k++) {
			const step = +p[i + k + 1] - +p[i + k]
			if (step !== 1) up = false
			if (step !== -1) down = false
		}
		if (up || down) return true
	}
	return false
}

/** First broken rule, in spec order. Returns ok when the passcode is accepted. */
export function checkPasscodePolicy(p: string): PasscodeCheck {
	if (!/^[0-9]*$/.test(p)) return { ok: false, reason: 'non_digit' }
	if (p.length < PASSCODE_MIN_DIGITS) return { ok: false, reason: 'too_short' }
	if (p.length > PASSCODE_MAX_DIGITS) return { ok: false, reason: 'too_long' }
	if (/^(\d)\1+$/.test(p)) return { ok: false, reason: 'all_same' }
	if (p.length % 2 === 0 && p === p.slice(0, 2).repeat(p.length / 2)) return { ok: false, reason: 'repeat_pair' }
	if (PASSCODE_COMMON.has(p)) return { ok: false, reason: 'common' }
	if (hasSixRun(p)) return { ok: false, reason: 'sequence' }
	if (isBirthdayLike8(p)) return { ok: false, reason: 'birthday' }
	return { ok: true }
}

/** Seconds of cooldown after `failures` consecutive wrong passcodes (table). Success resets to zero. */
export function backoffSecondsAfter(failures: number): number {
	if (failures <= 4) return 0
	if (failures === 5) return 30
	if (failures === 6) return 60
	if (failures === 7) return 300
	if (failures === 8) return 900
	return 3600
}
