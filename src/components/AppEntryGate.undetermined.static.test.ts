/**
 * (found by the browser check): an undetermined browser account is never routed to onboarding. The source
 * keeps the unavailable screen (with retry) for it. SYNTHETIC source checks; the browser run is recorded in the receipt.
 */
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('AppEntryGate: undetermined is never onboarding', () => {
	it('the storage router never goes to onboarding (every browser reason is undetermined)', () => {
		const router = src.slice(src.indexOf('const handleStorageUnavailable'), src.indexOf('// Shell'))
		expect(router).toContain("storageUnavailableRoute({ nativeShell, reason })")
		expect(router).toContain('showStorageUnavailable(reason)')
		expect(router).not.toContain('goOnboarding(')
	})
	it('the judged undetermined branch still routes through the same router', () => {
		expect(src).toContain("if (judged.account === 'undetermined') {\n\t\t\t\thandleStorageUnavailable('undetermined')")
	})
})
