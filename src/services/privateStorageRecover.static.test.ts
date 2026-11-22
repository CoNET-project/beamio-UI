/**
 * 2026-11-17 private-browsing Recover fixes (points 1, 2, 4 of the independent pre-read). Reads the source: the behaviour is covered
 * by the restore and entry suites; these pins keep the three fixes from being reverted silently.
 */
import fs from 'fs'
import path from 'path'

const beamio = fs.readFileSync(path.join(__dirname, 'beamio.ts'), 'utf8')
const screen = fs.readFileSync(path.join(__dirname, '..', 'pages', 'Home', 'RestoreWalletUnifiedScreen.tsx'), 'utf8')

describe('private-storage Recover: the onboarding gate holds on any non-empty status (point 1)', () => {
	it('the browser branch no longer folds a timeout into null', () => {
		const fn = beamio.slice(beamio.indexOf('export async function readWalletRecordForOnboardingGate'))
		expect(fn.slice(0, 500)).not.toContain('checkStorageWithTimeout(timeoutMs)')
		expect(fn.slice(0, 500)).toContain('checkStorageWithStatusWithTimeout(timeoutMs)')
		expect(fn.slice(0, 500)).toContain("if (r.status === 'empty') return null")
	})
})

describe('private-storage Recover: restore reports why it failed (point 2)', () => {
	it('restoreWithRedeemDetailed has the four kinds and a chain read is its own failure kind', () => {
		expect(beamio).toContain("export const restoreWithRedeemDetailed")
		expect(beamio).toContain("{ kind: 'chain_read_failed' }")
		expect(beamio).toContain("{ kind: 'invalid_code' }")
		expect(beamio).toContain("{ kind: 'unknown'")
	})
	it('the recovery screen says "invalid" only for invalid_code', () => {
		expect(screen).toContain("if (outcome.kind === 'invalid_code') {")
		expect(screen).toContain("setRecoveryError(tu('something_went_wrong_while_restoring_your_wallet'))")
	})
})

describe('private-storage Recover: the read-back must be the saved account (point 4)', () => {
	it('persistAndVerifyLocalWallet compares the keyID of the read-back with the saved one', () => {
		const fn = beamio.slice(beamio.indexOf('export const persistAndVerifyLocalWallet'), beamio.indexOf('export const MobileType'))
		expect(fn).toContain('readKey !== savedKey')
		expect(fn).toContain('IndexedDB account mismatch')
	})
})
