/**
 * Y.68: a registration answer key_mismatch records the retry state, which shows the notice only. The recorder takes a
 * PgpUpgradeStateCode (typed: the five spec codes); it has no runtime check, and it writes nothing else.
 */
import { pgpUpgradeRetryVisible, recordPgpUpgradeState, resetPgpUpgradeStateForTest } from './pgpUpgradeState'

beforeEach(() => resetPgpUpgradeStateForTest())

describe('Y.68 key_mismatch notice', () => {
	it('recording pgp_migration_retry shows the notice', () => {
		recordPgpUpgradeState('pgp_migration_retry')
		expect(pgpUpgradeRetryVisible()).toBe(true)
	})

	it('a non-retry code hides it again', () => {
		recordPgpUpgradeState('pgp_migration_retry')
		recordPgpUpgradeState('keep_existing')
		expect(pgpUpgradeRetryVisible()).toBe(false)
	})
})

describe('the chat registration maps key_mismatch to the retry state (static)', () => {
	const chat = require('fs').readFileSync(require('path').join(__dirname, 'chat.ts'), 'utf8') as string
	it('records pgp_migration_retry for native_key_mismatch and nothing else in that branch', () => {
		expect(chat).toContain("if (!result.ok && result.reason === 'native_key_mismatch') recordPgpUpgradeState('pgp_migration_retry')")
	})
})
