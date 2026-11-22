/**
 * @jest-environment node
 *
 * G0 (no key on the device) enters the onboarding: "Get started" (create) first, then "Unlock wallet" (the native recovery entry).
 * The import route is not the G0 page. Reads the sources.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { judgeShellFromNative } from '../services/accountJudgement'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'src', rel), 'utf8')

describe('G0 entry: the no-key state goes to the onboarding, not the import route', () => {
	const gate = read('components/AppEntryGate.tsx')

	it('the entry gate does not turn walletStatus no_key into the import route', () => {
		expect(gate).not.toMatch(/readNativeWalletStatus/)
		expect(gate).not.toMatch(/status === 'no_key'\) \{ setSplashVisible\(false\); setNativeNoKey\(true\)/)
	})

	// The init-level "page wallet decides (boundary)" branch was removed by cebd7e0; the boundary is now the pure rule: a valid page
	// mnemonic decides the account whatever the native no_key says (accountJudgement.test.ts, "a valid IndexedDB key still makes an existing account").
	it('a valid page mnemonic decides for a no_key native wallet (boundary: the PWA keeps its own EOA)', () => {
		expect(judgeShellFromNative({ idb: 'valid_mnemonic', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual({ account: 'has_account', action: 'enter' })
	})

	it('the native no-key watcher never takes over an app that has a page account (boundary)', () => {
		expect(gate).toContain('installNativeNoKeyWatcher(() => {')
		expect(gate).toContain('if (!noKeyCtl.onNativeNoKey()) return')
		expect(gate).toContain('NATIVE_WALLET_ESTABLISHED_EVENT')
	})
})

describe('G0 onboarding entry order is fixed: create first, then the native recovery entry', () => {
	const loading = read('pages/Home/LoadingPage.tsx')

	it('"Get started" comes before "Unlock wallet" in the onboarding modal', () => {
		const create = loading.indexOf("onClick={onGetStarted}")
		const restore = loading.indexOf("onClick={onRestoreWallet}")
		expect(create).toBeGreaterThan(0)
		expect(restore).toBeGreaterThan(create)
	})
})
