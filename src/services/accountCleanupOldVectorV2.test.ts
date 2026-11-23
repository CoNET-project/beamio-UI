/**
 * accountCleanupOld v2 vector (pinned by SHA256 d5325a9c…51ddcc). Read from the repository copy only.
 * CU-04 (own account unreadable: not_ready, retryable or not, noDelete), CU-05 (not confirmed: no command, no delete), CU-06 (gate locked
 * not_ready: no delete; item failure after the gate: clear_incomplete, pending kept). Every case maps to a non-deleting PWA outcome.
 * A native answer that is not available (not_available, or no answer at all) is a refusal too: the pending marker is kept, nothing is
 * deleted and no account is created.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { accountCleanupOutcomeOf } from './accountCleanupOld'

const PATH = join(__dirname, '__fixtures__', 'accountCleanupOld', 'accountCleanupOld-v2.json')
const SHA256 = 'd5325a9c73c0e8828726f66786f5077f87c32d3401447751570558602d51ddcc'

describe('accountCleanupOld v2 vector (pinned by SHA256)', () => {
	it('the copied file exists and matches the pinned SHA256', () => {
		expect(existsSync(PATH)).toBe(true)
		expect(createHash('sha256').update(readFileSync(PATH)).digest('hex')).toBe(SHA256)
	})
	const cases = (JSON.parse(readFileSync(PATH, 'utf8')) as { cases: Array<{ id: string; expect: Record<string, unknown> }> }).cases
	const cu = cases.filter((c) => c.id.startsWith('CU-0'))
	it('the CU-04/05/06 cases are present', () => {
		expect(cu.map((c) => c.id.slice(0, 5)).sort()).toEqual(['CU-04', 'CU-04', 'CU-05', 'CU-06', 'CU-06'])
	})
	for (const c of cu) {
		it(`${c.id}: no deletion; the marker is kept unless the answer is ok`, () => {
			const code = c.expect.code as string
			// the native answers are envelope-level: a not_ready / not_confirmed / clear_incomplete answer
			const outcome = accountCleanupOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: false, error: code, result: c.expect } })
			expect(outcome.kind).not.toBe('ok')
			if (code === 'clear_incomplete') expect(outcome).toEqual({ kind: 'incomplete' })
			else expect(outcome.kind).toBe('refused')
		})
	}
	it('a native answer that is not available (not_available, or no answer) is a refusal: nothing deleted', () => {
		expect(accountCleanupOutcomeOf({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_available' } })).toEqual({ kind: 'refused', code: 'not_available' })
		expect(accountCleanupOutcomeOf({ kind: 'timeout' }).kind).toBe('refused')
		expect(accountCleanupOutcomeOf({ kind: 'unavailable' }).kind).toBe('refused')
	})
})
