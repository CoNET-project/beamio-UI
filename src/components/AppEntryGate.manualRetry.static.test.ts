/**
 * @jest-environment node
 *
 * (manual retry), gate wiring. Static order checks. MR-6 to MR-8 are my own naming.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('manual retry wiring', () => {
	it('MR-6: a held write is recorded only on the failed branch with rollback_pending', () => {
		const at = gate.indexOf("if (outcome?.kind === 'failed') {")
		expect(at).toBeGreaterThan(0)
		expect(gate.slice(at, at + 260)).toContain('recordForFailure({ code: outcome.code')
		expect(gate.slice(at, at + 260)).toContain('writeFailureRecord(failureStore(), rec)')
	})

	it('MR-7: the manual retry reads walletStatus live and refuses locked before it sends', () => {
		const at = gate.indexOf('const manualRetryShellSync = () => {')
		const live = gate.indexOf('queryNativeWalletStatusForPreCheck()', at)
		const refuse = gate.indexOf("if (st === 'locked') {", at)
		const send = gate.indexOf('void sendPhraseOnce(payload)', at)
		expect(at).toBeGreaterThan(0)
		expect(live).toBeGreaterThan(at)
		expect(refuse).toBeGreaterThan(live)
		expect(send).toBeGreaterThan(refuse)
	})

	it('MR-8: the in-flight refusal comes before the confirmed key is cleared and the pair is sent', () => {
		const at = gate.indexOf('const manualRetryShellSync = () => {')
		const flight = gate.indexOf('phraseSyncs.current.inFlight.has(key)', at)
		const clear = gate.indexOf('phraseSyncs.current.confirmed.delete(key)', at)
		const send = gate.indexOf('void sendPhraseOnce(payload)', at)
		expect(flight).toBeGreaterThan(at)
		expect(clear).toBeGreaterThan(flight)
		expect(send).toBeGreaterThan(clear)
	})
})

const notice = readFileSync(join(__dirname, 'Home', 'ShellSyncNotice.tsx'), 'utf8')

describe('manual retry visibility and account change', () => {
	it('MR-11: the sync entry clears a held record of another account before it sends', () => {
		const at = gate.indexOf('const syncPageMnemonicToShell = () => {')
		const clear = gate.indexOf('if (held && !recordMatchesAccount(held, payload.eoa)) clearFailureRecord(failureStore())', at)
		const send = gate.indexOf('void sendPhraseOnce(payload)', at)
		expect(at).toBeGreaterThan(0)
		expect(clear).toBeGreaterThan(at)
		expect(send).toBeGreaterThan(clear)
	})

	it('MR-12: the held-write button is shown only after the live check (the notice gates it; the gate registers the check with the pure rule)', () => {
		expect(notice).toContain('checkShellManualRetry()')
		expect(notice).toContain('!heldWrite || manualAllowed')
		expect(gate).toContain('setShellSyncManualCheck(async () => {')
		expect(gate).toContain('manualRetryVisible({')
		expect(gate).toContain("lastReplyEnvelopeLocked: lastReplyLocked.current")
	})
})

describe('PWA-RETRY-03 wiring', () => {
	it('RR-6: the reread-first retry calls walletEoaAddress before any send and refuses an in-flight pair', () => {
		const at = gate.indexOf('const rereadThenSync = () => {')
		const reread = gate.indexOf('readWalletEoaAddress()', at)
		const hold = gate.indexOf("if (decision === 'hold') {", at)
		const flight = gate.indexOf('phraseSyncs.current.inFlight.has(`${payload.eoa}|${payload.phrase}`)', at)
		const send = gate.indexOf('syncPageMnemonicToShell()', flight)
		expect(at).toBeGreaterThan(0)
		expect(reread).toBeGreaterThan(at)
		expect(hold).toBeGreaterThan(reread)
		expect(flight).toBeGreaterThan(hold)
		expect(send).toBeGreaterThan(flight)
	})

	it('RR-6b: the home retry uses the reread path for internal_state and storage_write', () => {
		expect(gate).toContain('else if (needsReread(getShellSyncState())) rereadThenSync()')
	})
})
