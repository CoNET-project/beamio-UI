/**
 * accountCleanupOld v3 vector (pinned by SHA256 51f71328…6519f). The file is read from the repository copy only.
 * Each case's answer maps to the PWA outcome: ok clears the journal; clear_incomplete is resumable; any other answer is a refusal that keeps the
 * marker and deletes nothing.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { accountCleanupOutcomeOf } from './accountCleanupOld'

const PATH = join(__dirname, '__fixtures__', 'accountCleanupOld', 'accountCleanupOld-v3.json')
const SHA256 = '51f71328ba30f9019fc00fb8b3ae31c818910d8a3bc9b065a2c483a61856519f'

describe('accountCleanupOld v3 vector (pinned by SHA256)', () => {
	it('the copied file exists and matches the pinned SHA256', () => {
		expect(existsSync(PATH)).toBe(true)
		expect(createHash('sha256').update(readFileSync(PATH)).digest('hex')).toBe(SHA256)
	})
	const cases = (JSON.parse(readFileSync(PATH, 'utf8')) as { cases: Array<{ id: string; expect: Record<string, unknown> }> }).cases
	for (const c of cases) {
		it(`${c.id} maps to the PWA outcome, and only ok clears the journal`, () => {
			const outcome = accountCleanupOutcomeOf({ kind: 'payload', payload: c.expect as Record<string, unknown> })
			const ok = c.expect.ok === true
			const error = c.expect.error as string | undefined
			if (ok) expect(outcome).toEqual({ kind: 'ok' })
			else if (error === 'clear_incomplete') expect(outcome).toEqual({ kind: 'incomplete' })
			else expect(outcome.kind).toBe('refused')
			expect(outcome.kind === 'ok').toBe(ok)
		})
	}
	it('the vector has the three cases (gate not_ready, item clear_incomplete, success)', () => {
		expect(cases.map((c) => c.id)).toEqual(['BR3-05-gate-not_ready', 'BR3-06-item-clear_incomplete', 'BR3-07-success'])
	})
})
