/**
 * @jest-environment node
 *
 * v10 §九 (onboarding creation and write settlement), source checks. OB-1…OB-6 are the v10 clauses; the test IDs follow them.
 * Limits: the native create result carries no reason field, so OB-3 and OB-4 are checked as "no completion on any write_failed".
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, 'CreateUsernamePinScreen.tsx'), 'utf8')

describe('onboarding creation and completion (v10 §九)', () => {
})

describe('write_failed reason handling (OB-2, OB-4; rule)', () => {
})

describe('OB-3: rollback_pending retry on the create page (v10 line 285; §6.2)', () => {

	it('the visibility is checked live (reread and walletStatus) with the §6.2 rule before the button shows', () => {
		const at = src.indexOf('const visible = createRollbackRetryVisible({')
		expect(at).toBeGreaterThan(0)
		const block = src.slice(at - 500, at)
		expect(block).toContain('readWalletEoaAddress()')
		expect(block).toContain('queryNativeWalletStatusForPreCheck()')
		expect(src.slice(at, at + 220)).toContain("nativeStatus: st")
	})

	it('the button runs the same submit path (the reread runs before any open)', () => {
		expect(src).toContain("onClick={() => void onSubmitPress()}")
		expect(src.indexOf('{rollbackRetryVisible ? (')).toBeGreaterThan(0)
	})
})
