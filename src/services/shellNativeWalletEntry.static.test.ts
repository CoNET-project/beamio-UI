/**
 * @jest-environment node
 *
 * Shell wallet entry on the native wallet (PWA;). After a native recovery the app asks the native wallet state
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
		//the walletStatus shape is parsed by the pure parser (accountPresence); the public address is read from accountKey there.
		expect(nr).toContain('parseWalletStatusResult(')
		expect(read('services/accountPresence.ts')).toContain("key.split(':')[0]")
	})

	it('AppEntryGate reads the page first in a shell, then asks the native pre-read; a valid answer enters the app (boundary: no key falls to the page judgement)', () => {
		const g = read('components/AppEntryGate.tsx')
		// rule (a), spec r2.4 item 42(5): the explicit no_key guard lengthens init; the window is 12000 characters so the browser read stays inside it.
		const init = g.slice(g.indexOf('const init = async () => {'), g.indexOf('const init = async () => {') + 30000)
		expect(init).toContain('if (nativeShellRef.current) {')
		// 0.53.39 (and): the shell start asks the native pre-read, not the walletStatus route (reachNativeWallet
		// and its no_key branch were removed from init); the pre-read valid answer enters on the native account.
		expect(init).toContain('queryNativeMnemonicPreread()')
		// 改写（IDB 先读，0.53.44 产品）：init 中合法预读答复走 adoptPrereadMnemonic（写入页 IDB 后进入首页），不再直接 applyNativeWallet
		// (the valid-answer adoption is one helper shared by the start and the one real read before an onboarding)
		expect(init).toContain('adoptValidPreread(pre, reqId)')
		expect(g).toContain('await adoptPrereadMnemonic(pre.phrase, pre.eoa, reqId)')
		// Rewritten for the current rule (PWA first, spec r2.4 item 42(1)(2)(3)): the page mnemonic is read before the native side, so the
		// page read is first in the shell. 产品现以 takePageMnemonicRead() 取页面 IDB 读取（内层 SHELL_PAGE_READ_TIMEOUT_MS 竞速）。
		// A valid page mnemonic enters without asking the native side (no reachNativeWallet).
		expect(init.indexOf('takePageMnemonicRead()')).toBeGreaterThan(-1)
		expect(init.indexOf('takePageMnemonicRead()')).toBeLessThan(init.indexOf('queryNativeMnemonicPreread()'))
		// in a shell, an unknown or not_ready native answer is the startup wait (never the storage-unavailable screen, never the page read).
		expect(init).not.toContain('showStorageUnavailable(`native_wallet_')
	})

	it('boundary : a shell keeps the account record in the page copy as before (profiles and beamio are stored)', () => {
		const b = read('services/beamio.ts')
		expect(b).toContain('if (temp.profiles) temp.profiles = profilesForPersist(ensureFlatProfiles(temp.profiles))')
		expect(b).not.toMatch(/delete \(temp as any\)\.profiles/)
	})

	it('a native recovery success signals the app instead of reloading the page', () => {
		const screenCode = read('pages/Home/RestoreWalletUnifiedScreen.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
		expect(screenCode).not.toMatch(/onNativeRecoveryResult|reachNativeWallet|notifyNativeWalletReady/)
		const g = read('components/AppEntryGate.tsx')
		const start = g.indexOf("return onNativeRecoveryResult(({ code, eoa }) => {")
		expect(start).toBeGreaterThan(-1)
		const block = g.slice(start, start + 1400)
		expect(block).toContain('announceNativeWalletEstablished()')
		expect(block).toContain("void reachNativeWallet().then(() => notifyNativeWalletReady(''))")
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
