/**
 * the wiring of the account judgement. The gate and the storage read cannot run under jest as a whole, so their
 * wiring is checked by source; the decisions are run-time tested in accountJudgement.test.ts. SYNTHETIC values only.
 */
import fs from 'fs'
import path from 'path'

const beamio = fs.readFileSync(path.join(__dirname, 'beamio.ts'), 'utf8')
const gate = fs.readFileSync(path.join(__dirname, '..', 'components', 'AppEntryGate.tsx'), 'utf8')
const native = fs.readFileSync(path.join(__dirname, 'nativeRecovery.ts'), 'utf8')

describe('the storage read: a BeamioTag without a key is undetermined, not loaded and not onboarding', () => {
	it('a completed account without a key is unavailable (retry) in the browser and in the shell', () => {
		expect(beamio).toContain("return { status: 'unavailable', reason: isShellContext() ? 'native_recovery_needed' : 'invalid_document' }")
	})
	it('a trusted empty blob is the only no-key record that is empty', () => {
		expect(beamio).toContain('if (isTrustedEmptyWalletBlob(data)) {')
	})
})

describe('the native state: walletState from passcodeStatus is the only basis ', () => {
	it('the query sends passcodeStatus and reads walletState through the strict parser', () => {
		expect(native).toContain("export const NATIVE_PASSCODE_STATUS_COMMAND = 'passcodeStatus'")
		expect(native).toContain('return parsePasscodeStatus(p.result)')
	})
})

describe('the gate: judged from the read and walletState; undetermined never onboards; locked shows the passcode page (GY)', () => {
	it('the shell reads walletState first; a locked walletState shows the passcode page, judged again after the unlock', () => {
		expect(gate).toContain('shellWalletState = await queryNativeWalletState()')
		expect(gate).toContain("if (shellWalletState === 'locked' && identity === 'declared') {")
	})
	it('a build without walletState keeps the existing route (not_reported); a reported state is judged by judgeShell', () => {
		expect(gate).toContain("if (shellWalletState === 'not_reported') {")
		expect(gate).toContain("judgeShellFromNative({ idb, walletState: shellWalletState ?? 'not_reported', walletStatus: shellWalletStatus })")
	})
	it('undetermined shows the retry screen; the create or restore page is reached only from no_account', () => {
		expect(gate).toContain("if (judged.account === 'undetermined') {")
		expect(gate).toContain("handleStorageUnavailable('undetermined')")
		expect(gate).toContain("const provisioned = presence === 'no_account'")
	})
	it('an existing account with no record on the device retries; it never reaches the create page', () => {
		expect(gate).toContain("if (presence === 'has_account' && CoNETData == null) {")
	})
	it('the judgement log carries the state only, never a key', () => {
		expect(gate).toContain('publishNativePwaLog(\'info\', `[AppEntryGate] account judgement=${judged.account} action=${judged.action}`)')
	})
})

describe('the account creation page keeps a confirmed local key', () => {
	it('createRecover asks the local store first; only a confirmed empty store creates a new wallet', () => {
		expect(beamio).toContain('const source = recoverSourceOf({')
		expect(beamio).toContain("if (source === 'refuse') throw new LocalCreateError('local_wallet_unconfirmed')")
		expect(beamio).toContain("const temp = source === 'reuse_local' && local.status === 'loaded'")
	})
})

