/**
 * @jest-environment node
 *
 * OB-3 create-page rule (see createRollbackRetry.ts). OB3-1…OB3-4 are my own naming.
 */
import { createRollbackRetryVisible } from './createRollbackRetry'

const VALID = { kind: 'address' as const }
const ABSENT = { kind: 'refused' as const, code: 'no_key' }
const HOLD = { kind: 'refused' as const, code: 'locked' }

describe('OB-3 create-page retry rule', () => {
	it('OB3-1: rollback_pending, a valid or absent reread, walletStatus not locked: shown', () => {
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: VALID, nativeStatus: 'unlocked' })).toBe(true)
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: ABSENT, nativeStatus: 'no_key' })).toBe(true)
	})

	it('OB3-2: walletStatus locked (the rollback is not settled yet): hidden', () => {
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: VALID, nativeStatus: 'locked' })).toBe(false)
	})

	it('OB3-2b: every walletStatus value outside the whitelist (no_key, unlocked) is hidden: not_ready, unknown, unavailable, timeout, phrase_only', () => {
		for (const nativeStatus of ['not_ready', 'unknown', 'unavailable', 'timeout', 'phrase_only', 'locked']) {
			expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: VALID, nativeStatus })).toBe(false)
		}
	})

	it('OB3-2c: the whitelisted values (no_key, unlocked) show the button when the other conditions hold', () => {
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: VALID, nativeStatus: 'unlocked' })).toBe(true)
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: ABSENT, nativeStatus: 'no_key' })).toBe(true)
	})

	it('OB3-3: an unknown reread, or any other reason (including no reason): hidden', () => {
		expect(createRollbackRetryVisible({ reason: 'rollback_pending', reread: HOLD, nativeStatus: 'unlocked' })).toBe(false)
		expect(createRollbackRetryVisible({ reason: 'internal_state', reread: VALID, nativeStatus: 'unlocked' })).toBe(false)
		expect(createRollbackRetryVisible({ reason: undefined, reread: VALID, nativeStatus: 'unlocked' })).toBe(false)
	})

	it('OB3-4: the page effect reads only the live inputs (no fabricated record or account flags)', () => {
		const fs = require('fs') as typeof import('fs')
		const path = require('path') as typeof import('path')
		const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'Home', 'CreateUsernamePinScreen.tsx'), 'utf8')
		expect(src).toContain('createRollbackRetryVisible({')
		expect(src).not.toContain('hasRecord: true')
		expect(src).not.toContain('accountMatches: true')
	})
})
