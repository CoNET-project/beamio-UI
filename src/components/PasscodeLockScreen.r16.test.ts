/**
 * @jest-environment node
 *
 * source checks: the screen defaults to the page lock; the gate passes the lock kind for each branch.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const screen = readFileSync(join(__dirname, 'PasscodeLockScreen.tsx'), 'utf8')
const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('forgot-passcode by lock kind (source)', () => {
	it('defaults to the page lock and offers forgot only for it', () => {
		expect(screen).toContain("lock = 'page'")
		expect(screen).toContain("{!forgot && lock === 'page' && (")
	})

	it('the gate passes the lock kind to the screen', () => {
		expect(gate).toContain('lock={vaultLockKind}')
	})

	it('native-side lock branches set native; the page-storage lock sets page', () => {
		const native = gate.split("setVaultLockKind('native')").length - 1
		const page = gate.split("setVaultLockKind('page')").length - 1
		// three native-side branches: judged unlock, sign-out, and the unlock entry of the native-locked retry. The iOS pre-read lock (L-PRE)
		// no longer shows the passcode page: a native lock with no PWA mnemonic is a retry with an unlock entry
		expect(native).toBe(3)
		expect(page).toBe(1)
		// four lock assignments: the three native-side branches and the page-storage lock (the page lock is counted by setVaultLockKind('page'))
		expect(gate.split('setVaultLocked(true)').length - 1).toBe(4)
	})
})
