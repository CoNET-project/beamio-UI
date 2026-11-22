/**
 * The claimBUnits gate is wired in App.tsx before the automatic claim. The wiring is a source check; the rule itself
 * is behaviour-tested in firstOpenClaimGate.test.ts. Other explicit claim entries are not checked here (unchanged).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')

describe('claimBUnits first-open gate wiring', () => {
	it('App imports the gate and calls it before the automatic claim', () => {
		expect(app).toMatch(/import \{ autoBUnitClaimGated \} from "@\/services\/firstOpenClaimGateNow"/)
		const gate = app.indexOf('void autoBUnitClaimGated({')
		const claim = app.indexOf('claim: runAutoBUnitFreeClaimIfEligible')
		expect(gate).toBeGreaterThan(0)
		expect(claim).toBeGreaterThan(gate)
	})

	it('the gate passes the shell flag from the shell context (a shell is never the browser first-open path)', () => {
		expect(app).toMatch(/autoBUnitClaimGated\(\{ privateKeyArmor: p0\.privateKeyArmor!, profile: p0, shell: isShellContext\(\), lookup: lookupRecipientRecord, claimant, claim: runAutoBUnitFreeClaimIfEligible \}\)/)
	})
})
