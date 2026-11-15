/**
 * when onboarding finishes in a shell, the gate does not clear the loading flag before the App's init has loaded the
 * account (the same rule as enterApp). A browser build keeps the clear. SYNTHETIC values only.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

describe('onboarding completion does not clear the bar before the account is loaded in a shell', () => {
	const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

	it('the onboarding home callback clears the loading flag only outside a shell', () => {
		const a = gate.indexOf('home={() => {')
		expect(a).toBeGreaterThan(-1)
		const b = gate.indexOf('onInitComplete', a)
		const block = gate.slice(a, b)
		expect(block).not.toMatch(/\n\t+setIsInitialLoading\(false\)\n/)
		expect(block).toContain('if (!isShellContext()) setIsInitialLoading(false)')
	})

	it('enterApp keeps the same rule', () => {
		expect(gate).toContain('if (!isShellContext()) setIsInitialLoading(false)')
	})
})
