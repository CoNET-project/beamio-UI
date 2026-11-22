/**
 * Silent cleanup of the old account: a verified recovery (native ok, the two read-backs agree) runs it silently,
 * with no extra pick and no notice. Entering the home, a failed or unverified recovery, and the onboarding page never start it.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('the silent cleanup is wired on the verified recovery only (approval 75edef25)', () => {
	it('the gate calls the verified entry on the recovery ok branch, nowhere else', () => {
		const gate = read('components/AppEntryGate.tsx')
		expect(gate.split('cleanupAfterVerifiedRecovery(').length - 1).toBe(1)
		expect(gate.indexOf('cleanupAfterVerifiedRecovery(window.localStorage')).toBeGreaterThan(gate.indexOf("if (code === 'ok') {"))
	})
	it('entering the home (the loading page) never references the cleanup', () => {
		const loading = read('pages/Home/LoadingPage.tsx')
		expect(loading).not.toMatch(/accountCleanupOld|cleanupAfterOnboardingRecovery|cleanupAfterVerifiedRecovery|startCleanupAfterRecovery/)
	})
	it('no extra confirmation step or notice is added for the cleanup', () => {
		const gate = read('components/AppEntryGate.tsx')
		expect(gate).not.toMatch(/clean(ing)? (this device|the old)|清理此设备|confirm.*cleanup/i)
	})
	it('the cleanup module removes only on ok (a refusal removes nothing)', () => {
		const mod = read('services/accountCleanupOld.ts')
		expect(mod).toContain("if (p.type === 'ack' && p.ok === true) return { kind: 'ok' }")
	})
})
