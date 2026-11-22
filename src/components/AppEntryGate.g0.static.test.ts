/**
 * a native `no_key`never sends the user to onboarding by itself. The gate reads the page store after no_key; only a
 * store read that answers absent (a confirmed empty store) reaches onboarding; a record that is there enters the app; an unreadable store
 * stops at unavailable. The import route is governed by nativeNoKeyTakesOver (appEntryNoKeyPolicy). A removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { judgeShellFromNative } from '../services/accountJudgement'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const policy = readFileSync(join(__dirname, 'appEntryNoKeyPolicy.ts'), 'utf8')

describe('G0: no_key does not send the user to onboarding by itself', () => {
	// The walletStatus no_key text branch was removed by cebd7e0; the rule now lives in the pure judgement (accountJudgement.test.ts,
	// "walletStatus no_key is undetermined, never absent, never onboarding"): no_key without a confirmed empty store is retry.
	it('a walletStatus no_key alone is undetermined (retry), never onboarding; the confirmed empty store is required', () => {
		expect(judgeShellFromNative({ idb: 'absent', walletState: 'not_reported', walletStatus: 'no_key' })).toEqual({ account: 'undetermined', action: 'retry' })
	})

	it('onboarding follows only the store read (a confirmed empty store), after the read', () => {
		const read = gate.indexOf('const storageResult = await checkStorageWithTransientRetry()')
		const onboarding = gate.indexOf('goOnboarding(false)', read)
		expect(onboarding).toBeGreaterThan(read)
		expect(gate).toContain("noKeyCtl.storageRead(storageResult.status === 'empty')")
	})

	it('a record that is there enters the app; the import route needs a confirmed empty store and no wallet', () => {
		expect(gate).toContain('if (hasAccount) {')
		expect(policy).toContain('s.storageConfirmedEmpty')
		expect(policy).toContain('!s.walletEstablished')
	})
})
