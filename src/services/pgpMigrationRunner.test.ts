/**
 * PGP migration runner: one run per session; the state is kept in memory; a second start does nothing.
 */
import { getPgpMigrationState, resetPgpMigrationRunnerForTest, subscribePgpMigrationState } from './pgpMigrationRunner'

describe('PGP migration runner', () => {
	beforeEach(() => resetPgpMigrationRunnerForTest())

	it('starts idle; the state is readable and observable', () => {
		expect(getPgpMigrationState()).toBe('idle')
		const seen: string[] = []
		const off = subscribePgpMigrationState((s) => seen.push(s))
		off()
		expect(seen).toEqual([])
	})
})
