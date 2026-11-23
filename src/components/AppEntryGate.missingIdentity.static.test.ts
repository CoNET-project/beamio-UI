/**
 * @jest-environment node
 *
 * The gate with the identity capability missing: the start waits (no passcode page, no native read for a local home, no import page).
 * A static check of the source; the behaviour is covered by the native init test.
 * 0.53.39: the local home on the native public address was removed on purpose (it must not be reachable), so its pins are gone.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('the gate with the identity capability missing', () => {
	it('probes the capability once per start, and no other probe is made in the init', () => {
		expect(gate.match(/identity = await shellIdentityState\(\)/g)).toHaveLength(1)
	})

	it('shows no passcode page while the capability is missing: the undeclared identity returns before the judgement that unlocks', () => {
		const identityAt = gate.indexOf('if (!identityDeclared) {')
		const unlockAt = gate.indexOf("if (judged.action === 'unlock') {")
		expect(identityAt).toBeGreaterThan(0)
		expect(unlockAt).toBeGreaterThan(identityAt)
	})

	it('never reads the native address and never shows the import page while the capability is missing: the start waits', () => {
		const at = gate.indexOf('if (!identityDeclared) {')
		// window widened to the block's end (the pre-read): the 0.53.39 bridge-trust comment and deadline lines (3) lengthened it
		const block = gate.slice(at, gate.indexOf('const lateAnswer = lateReadRef.current.lateAnswer', at))
		expect(block).toContain('startupWait(')
		expect(block).toContain('return')
		expect(block).not.toContain('readWalletEoaAddress')
		expect(block).not.toContain('showStorageUnavailable')
	})
})
