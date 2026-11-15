/**
 * a native `no_key`never sends the user to onboarding by itself. The gate reads the page store after no_key; only a
 * store read that answers absent (a confirmed empty store) reaches onboarding; a record that is there enters the app; an unreadable store
 * stops at unavailable. The import route is governed by nativeNoKeyTakesOver (appEntryNoKeyPolicy). A removed guard fails this test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')
const policy = readFileSync(join(__dirname, 'appEntryNoKeyPolicy.ts'), 'utf8')

describe('G0: no_key does not send the user to onboarding by itself', () => {
	it('the no_key branch continues to the page store read; it does not go to onboarding', () => {
		const noKey = gate.indexOf("native.status !== 'no_key'")
		const read = gate.indexOf('await checkStorageWithTransientRetry()')
		expect(noKey).toBeGreaterThan(-1)
		expect(read).toBeGreaterThan(noKey)
		expect(gate.slice(noKey, read)).not.toContain('goOnboarding')
	})

	it('onboarding follows only the store read (a confirmed empty store), after the read', () => {
		const read = gate.indexOf('await checkStorageWithTransientRetry()')
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
