/**
 * Passcode policy and backoff against the shared vector file (passcode-vectors.v1.json; sha256 prefix
 * fec956944a45ca52 after the metadata-only edits recorded in PROVENANCE.md).
 * SYNTHETIC values only.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { backoffSecondsAfter, checkPasscodePolicy, isBirthdayLike8 } from './passcodeRules'

const VECTOR_PATH = join(__dirname, 'passcode-vectors.v1.json')
const vectors = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'))


describe('shared vectors', () => {
	it('the published vector file matches its recorded sha256 prefix', () => {
		const hash = createHash('sha256').update(readFileSync(VECTOR_PATH)).digest('hex')
		expect(hash.slice(0, 16)).toBe('fec956944a45ca52')
	})

	for (const c of vectors.policy.cases as Array<{ passcode: string; expectOk: boolean; expectReason?: string; result: { ok: boolean; reason?: string } }>) {
		it(`policy case ${c.passcode}`, () => {
			const got = checkPasscodePolicy(c.passcode)
			if (c.expectOk) {
				expect(got).toEqual({ ok: true })
			} else {
				expect(got).toEqual({ ok: false, reason: (c.expectReason ?? c.result.reason) })
			}
		})
	}

	it('backoff table matches the vector schedule', () => {
		for (const row of vectors.backoff.schedule) {
			expect(backoffSecondsAfter(row.consecutiveFailures)).toBe(row.cooldownSec)
		}
	})
})

describe('rules beyond the vector list', () => {
	it('refuses 8-digit birthday-like values (YYYYMMDD, MMDDYYYY, DDMMYYYY) with a valid date and year 1900–2099', () => {
		expect(checkPasscodePolicy('19900315')).toEqual({ ok: false, reason: 'birthday' })
		expect(checkPasscodePolicy('03151990')).toEqual({ ok: false, reason: 'birthday' })
		expect(checkPasscodePolicy('15031990')).toEqual({ ok: false, reason: 'birthday' })
	})

	it('accepts 8-digit values that are not valid dates, and years outside 1900–2099', () => {
		expect(isBirthdayLike8('20250230')).toBe(false) // no February 30
		expect(isBirthdayLike8('21001231')).toBe(false) // year 2100
	})

	it('refuses a two-digit cycle and a six-digit run, in spec order', () => {
		expect(checkPasscodePolicy('12121212')).toEqual({ ok: false, reason: 'repeat_pair' })
		expect(checkPasscodePolicy('48123456')).toEqual({ ok: false, reason: 'sequence' })
		expect(checkPasscodePolicy('98765432')).toEqual({ ok: false, reason: 'sequence' })
	})

	it('accepts an ordinary random-looking 8 to 12 digit code', () => {
		expect(checkPasscodePolicy('482915736')).toEqual({ ok: true })
		expect(checkPasscodePolicy('739104862517')).toEqual({ ok: true })
	})
})
