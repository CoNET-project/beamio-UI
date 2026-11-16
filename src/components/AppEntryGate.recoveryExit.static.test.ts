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
		expect(g).toContain('nativeRecoveryOpen()')
		expect(g).toContain("{tu('use_recovery_code')}")
		expect(g).toContain('recoveryOpenErrorKey(out.reason)')
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

	it('the store-not-ready reasons keep a wait with a retry, never onboarding (native_retry)', () => {
		const g = read('AppEntryGate.tsx')
		// the native retry is decided by the pure router (storageRoute.ts); every other reason is the unavailable screen.
		expect(g).toContain("storageUnavailableRoute({ nativeShell, reason }) === 'native_retry'")
		expect(g).toContain('window.setTimeout(() => void init(), nativeStoreWaitDelayMs(attempt))')
		expect(g).toContain('splashDeadlineAction({ decided: decisionMadeRef.current, nativeWaiting: nativeWaitRef.current })')
		expect(g).not.toContain('goOnboarding(false)\n\t\t\treturn\n\t\t}\n\t\tshowStorageUnavailable')
		expect(read('../services/shellStoreWait.ts')).toMatch(/shell_record_\(migrating\|import_not_done\|legacy_store_unreadable\|not_ready\|timeout\|native_unavailable\)\\b/)
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
