/**
 * Y.91 CU-01 to CU-08 (accountCleanupOldCases in pgp-migration-vectors.v2.json, sha256 5f9952f3…dc75). The native layer does the removal; these
 * tests pin the page side: the command shape, the result mapping, and the resume with the same idempotencyKey. SYNTHETIC values only.
 */
import { accountCleanupOutcomeOf, buildAccountCleanupOldCommand, runAccountCleanupOld } from './accountCleanupOld'

const ACCOUNT = 'eoa-new:default'
const ack = (ok: boolean, error?: string) => ({ kind: 'payload', payload: { type: 'ack', ok, ...(error ? { error } : {}) } })

describe('accountCleanupOld command (Y.91 3)', () => {
	it('the command carries exactly type, reqId, accountKey and idempotencyKey, and no confirmation field', () => {
		const cmd = buildAccountCleanupOldCommand(ACCOUNT, 'idem-1')
		expect(Object.keys(cmd).sort()).toEqual(['accountKey', 'idempotencyKey', 'reqId', 'type'])
		expect(cmd.type).toBe('accountCleanupOld')
		expect(cmd.accountKey).toBe(ACCOUNT)
		expect(cmd.idempotencyKey).toBe('idem-1')
		expect(typeof cmd.reqId).toBe('number')
	})
})

describe('result mapping (CU-01 to CU-06)', () => {
	it('CU-01: ok is the only success', () => {
		expect(accountCleanupOutcomeOf(ack(true))).toEqual({ kind: 'ok' })
	})

	it('CU-02: a payload with a confirmation is refused by the native layer; the page reports the refusal', () => {
		expect(accountCleanupOutcomeOf(ack(false, 'confirmation_not_native'))).toEqual({ kind: 'refused', code: 'confirmation_not_native' })
	})

	it('CU-03 to CU-06: not_confirmed, not_available, account_mismatch and not_ready are refusals (nothing removed)', () => {
		for (const code of ['not_confirmed', 'not_available', 'account_mismatch', 'not_ready']) {
			expect(accountCleanupOutcomeOf(ack(false, code))).toEqual({ kind: 'refused', code })
		}
	})

	it('a missing answer is a refusal, never a success', () => {
		expect(accountCleanupOutcomeOf({ kind: 'timeout' })).toEqual({ kind: 'refused', code: 'timeout' })
	})
})

describe('partial cleanup and resume (CU-07, CU-08)', () => {
	it('CU-07: a partial cleanup is incomplete; the page keeps the cleanup pending (not an absent account)', () => {
		expect(accountCleanupOutcomeOf(ack(false, 'clear_incomplete'))).toEqual({ kind: 'incomplete' })
	})

	it('CU-08: the resume uses the same idempotencyKey and ends ok; old items already removed are not repeated', async () => {
		const keys: string[] = []
		const answers = [ack(false, 'clear_incomplete'), ack(true)]
		const send = jest.fn(async (cmd: { idempotencyKey: string }) => {
			keys.push(cmd.idempotencyKey)
			return answers.shift()!
		})
		const out = await runAccountCleanupOld({ accountKey: ACCOUNT, idempotencyKey: 'idem-7', send })
		expect(out).toEqual({ kind: 'ok' })
		expect(keys).toEqual(['idem-7', 'idem-7'])
	})

	it('an exhausted resume stays incomplete: the account is never treated as absent', async () => {
		const send = jest.fn(async () => ack(false, 'clear_incomplete'))
		const out = await runAccountCleanupOld({ accountKey: ACCOUNT, idempotencyKey: 'idem-9', send, maxAttempts: 2 })
		expect(out).toEqual({ kind: 'incomplete' })
		expect(send).toHaveBeenCalledTimes(2)
	})

	it('a refusal stops at once and is not retried', async () => {
		const send = jest.fn(async () => ack(false, 'account_mismatch'))
		const out = await runAccountCleanupOld({ accountKey: ACCOUNT, idempotencyKey: 'idem-3', send })
		expect(out).toEqual({ kind: 'refused', code: 'account_mismatch' })
		expect(send).toHaveBeenCalledTimes(1)
	})
})

describe('no cleanup on entering onboarding (Y.91 1, Y.85 3(c))', () => {
	it('the gate and the onboarding page never reference the cleanup command', () => {
		const fs = require('fs')
		const path = require('path')
		for (const rel of ['components/AppEntryGate.tsx', 'pages/Home/LoadingPage.tsx']) {
			const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
			expect(src).not.toMatch(/accountCleanupOld|runAccountCleanupOld|sendAccountCleanupOld/)
		}
	})
})
