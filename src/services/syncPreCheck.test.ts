/**
 * @jest-environment node
 *
 * C1. The pre-sync decision: walletState locked, corrupt, unknown or timeout, or walletStatus locked, unknown or timeout, is pending.
 * Test IDs C1-1 to C1-3 cover the decision; C1-4 to C1-6 cover the pending store and the gate wiring (see the static test).
 */
import { syncPreCheckDecision } from './syncPreCheck'
import { markPendingSync, takePendingSync, hasPendingSync } from './pendingSync'
import * as fs from 'fs'
import * as path from 'path'

describe('C1: pre-sync decision', () => {
	it('C1-1: walletState locked, corrupt, unknown or timeout is pending', () => {
		for (const walletState of ['locked', 'corrupt', 'unknown', 'timeout'] as const) {
			expect(syncPreCheckDecision({ walletState, walletStatus: 'unlocked' })).toBe('pending')
		}
	})

	it('C1-2: walletStatus locked, unknown, unavailable or timeout is pending', () => {
		for (const walletStatus of ['locked', 'unknown', 'unavailable', 'timeout'] as const) {
			expect(syncPreCheckDecision({ walletState: 'present', walletStatus })).toBe('pending')
		}
	})

	it('C1-3: a present, unlocked wallet (and a not_reported walletState) syncs', () => {
		expect(syncPreCheckDecision({ walletState: 'present', walletStatus: 'unlocked' })).toBe('sync')
		expect(syncPreCheckDecision({ walletState: 'not_reported', walletStatus: 'unlocked' })).toBe('sync')
	})

	it('C1-4: a held sync is taken once: the take clears it, so the unlock resumes it exactly once', () => {
		markPendingSync('pre_sync_locked_or_unknown')
		expect(hasPendingSync()).toBe(true)
		expect(takePendingSync()).toEqual({ reason: 'pre_sync_locked_or_unknown' })
		expect(takePendingSync()).toBeNull()
		expect(hasPendingSync()).toBe(false)
	})

	it('C1-5: the gate runs the pre-check before any automatic send', () => {
		const gate = fs.readFileSync(path.join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const at = gate.indexOf('const syncPageMnemonicToShell = () => {')
		const pre = gate.indexOf('runSyncPreCheck(queryNativeWalletStateForPreCheck, queryNativeWalletStatusForPreCheck)', at)
		const send = gate.indexOf('void sendPhraseOnce(payload)', at)
		expect(at).toBeGreaterThan(0)
		expect(pre).toBeGreaterThan(at)
		expect(send).toBeGreaterThan(pre)
	})

	it('C1-6: an unlock (locked false) takes the held sync and resumes it; a lock does not', () => {
		const gate = fs.readFileSync(path.join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
		const at = gate.indexOf('installPasscodeStateWatcher((state) => {')
		expect(at).toBeGreaterThan(0)
		const block = gate.slice(at, at + 400)
		expect(block).toContain('if (state.locked) return')
		expect(block).toContain('if (takePendingSync()) syncPageMnemonicToShell()')
	})
})
