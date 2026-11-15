/**
 * @jest-environment node
 *
 * Shell wallet entry on the native wallet (PWA; ). After a native recovery the app asks the native wallet state
 * and enters on the public address; it does not reload and does not depend on page storage. The public seed holds no secret.
 * Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

describe('shell wallet entry on the native wallet', () => {
	it('the native wallet status is queried with walletStatus and the public address is read from accountKey', () => {
		const nr = read('services/nativeRecovery.ts')
		expect(nr).toContain("export const NATIVE_WALLET_STATUS_COMMAND = 'walletStatus'")
		expect(nr).toContain("key.split(':')[0]")
	})

	it('AppEntryGate asks the native wallet first in a shell; a native wallet enters the app; no key falls to the page wallet (boundary)', () => {
		const g = read('components/AppEntryGate.tsx')
		const init = g.slice(g.indexOf('const init = async () => {'), g.indexOf('const init = async () => {') + 5200)
		expect(init).toContain('if (nativeShellRef.current) {')
		expect(init).toContain('reachNativeWallet()')
		expect(init).toContain('applyNativeWallet(native.eoa)')
		expect(init).toContain("native.status !== 'no_key'")
		expect(init.indexOf('reachNativeWallet()')).toBeLessThan(init.indexOf('checkStorageWithTransientRetry()'))
		//in a shell, unknown and not_ready end here; the page storage is read only on the non-shell path below.
		expect(init).toContain('showStorageUnavailable(`native_wallet_${native.status}`)')
		expect(init.indexOf('showStorageUnavailable(`native_wallet_')).toBeLessThan(init.indexOf('checkStorageWithTransientRetry()'))
	})

	it('boundary : a shell keeps the account record in the page copy as before (profiles and beamio are stored)', () => {
		const b = read('services/beamio.ts')
		expect(b).toContain('if (temp.profiles) temp.profiles = profilesForPersist(ensureFlatProfiles(temp.profiles))')
		expect(b).not.toMatch(/delete \(temp as any\)\.profiles/)
	})

	it('a native recovery success signals the app instead of reloading the page', () => {
		const r = read('pages/Home/RestoreWalletUnifiedScreen.tsx')
		// residual: the listener is kept in a named constant so its cleanup can end the pending native flow.
		const start = r.indexOf("const offRecovery = onNativeRecoveryResult(({ code, eoa }) => {")
		expect(start).toBeGreaterThan(-1)
		const block = r.slice(start, start + 900)
		expect(block).toContain('reachNativeWallet()')
		expect(block).toContain('notifyNativeWalletReady(initialBeamioTag)')
		expect(block).not.toContain('window.location.reload()')
	})

	it('AppShell reads the in-memory native seed in a shell and does not treat a missing local mnemonic as a recover there', () => {
		const a = read('App.tsx')
		// (A): the in-memory seed is read again after the storage read (the native wallet may arrive during the read).
		expect(a).toContain('const fromStore = await checkStorage()')
		expect(a).toContain('isShellContext() && CoNET_Data?.profiles?.length ? CoNET_Data : fromStore')
		// The key-only decision is shell-aware: a shell build is never key-only (keyOnlyEntry.test.ts covers the decision).
		expect(a).toContain('keyOnlyEntryDecision(temp, isShellContext())')
	})

	it('the public seed holds no key, passphrase, mnemonic or recovery material', () => {
		const w = read('services/nativeWallet.ts')
		const seed = w.slice(w.indexOf('export function publicWalletSeed'), w.indexOf('export function notifyNativeWalletReady'))
		for (const forbidden of ['privateKey', 'mnemonic', 'recover', 'passphrase', 'pin', 'Armor']) {
			expect(seed.toLowerCase()).not.toContain(forbidden.toLowerCase())
		}
	})
})
