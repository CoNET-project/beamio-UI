/**
 * (static): the unavailable screen's native recovery exit reuses the existing command and copy, and the shell does
 * not re-normalise a loaded record into an empty wallet (the storage read decides).
 */
import fs from 'fs'
import path from 'path'

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8')

describe('AppEntryGate: native recovery exit and storage decision', () => {
	it('the empty-wallet normalisation runs only outside a shell (the storage read decides in a shell)', () => {
		const g = read('AppEntryGate.tsx')
		expect(g).toContain('if (!isShellContext() && CoNETData && isTrustedEmptyWalletBlob(CoNETData)) {')
	})

	it('the unavailable screen offers the existing native recovery command, with the existing button label and error keys', () => {
		const g = read('AppEntryGate.tsx')
		expect(g).toContain("storageUnavailable === 'native_recovery_needed'")
		expect(g).not.toContain('nativeRecoveryOpen()')  // 0.53.44: retired startup control (two-landing rule); must be absent
		expect(g).not.toContain("{tu('use_recovery_code')}")  // 0.53.44: retired startup control (two-landing rule); must be absent
		expect(g).not.toContain('recoveryOpenErrorKey(out.reason)')  // 0.53.44: retired startup control (two-landing rule); must be absent
	})

	it('a native recovery ok enters the app through the existing wallet-ready path; legacy_record uses the existing copy', () => {
		const g = read('AppEntryGate.tsx')
		expect(g).toContain('onNativeRecoveryResult(({ code, eoa }) => {')
		expect(g).toContain('announceNativeWalletEstablished()')
		expect(g).toContain('notifyNativeWalletReady(')
		expect(g).toContain('nativeRecoveryCopyKey(code)')
		expect(g).toContain('setNativeRecoveryNotice(tu(copyKey))')  // legacy_record keeps its copy through the mapping
	})

	it('the account screen and the other profile callers read the postBeamio result (queued sync is visible in the log)', () => {
		for (const rel of ['../components/Setting/BeamioAccountScreen.tsx', '../components/input/AmountCurrencyV2.tsx', '../pages/Pay/PayForm.tsx', '../components/Home/Home.tsx']) {
			expect(read(rel)).toContain('profileSyncPending(')
		}
	})

	it('the store-not-ready reasons keep a background wait with the re-read schedule, never onboarding (shell)', () => {
		const g = read('AppEntryGate.tsx')
		// 2026-11-22: the shell has no screen for these reasons; the native retry branch was unreachable and is removed.
		expect(g).toContain('if (nativeShell && !SHELL_SCREEN_REASONS.has(reason)) {')
		expect(g).toContain('startupWait(`shell background: ${reason}`, shellWaitCodeOf(reason))')
		expect(g).toContain('splashDeadlineAction({ decided: decisionMadeRef.current, nativeWaiting: nativeWaitRef.current })')
		expect(g).not.toContain('goOnboarding(false)\n\t\t\treturn\n\t\t}\n\t\tshowStorageUnavailable')
		expect(read('../services/shellStoreWait.ts')).toMatch(/shell_record_\(migrating\|import_not_done\|not_ready\|timeout\|native_unavailable\)\\b/)
	})

	it('the approved notice is mounted on the account page, only while an unsynced item is queued', () => {
		expect(read('Setting/BeamioAccountScreen.tsx')).toContain('<PendingServerSyncNotice />')
		expect(read('AppEntryGate.tsx')).not.toContain('PendingServerSyncNotice')
		expect(read('PendingServerSyncNotice.tsx')).toContain('资料已保存在本机，将在网络恢复后同步到服务器。')
	})

	it('the explicit result checks (false is a failure, deferred is queued) are in the three callers', () => {
		expect(read('../renderAction/ActionRenderer.tsx')).toContain('serverSync === false')
		expect(read('../renderAction/GenerateAvatarImageCard.tsx')).toContain('serverSync !== false')
	})
})
