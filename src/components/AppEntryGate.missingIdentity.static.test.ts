/**
 * @jest-environment node
 *
 * The gate with the identity capability missing: the lock page is not shown, the local home is entered on the public
 * address, and the import page is not shown. A static check of the source; the behaviour is covered by the native init test.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const gate = readFileSync(join(__dirname, 'AppEntryGate.tsx'), 'utf8')

describe('the gate with the identity capability missing', () => {
	it('probes the capability once per start, and no other probe is made in the init', () => {
		expect(gate.match(/identity = await shellIdentityState\(\)/g)).toHaveLength(1)
	})

	it('shows no passcode page while the capability is missing', () => {
		expect(gate).toContain("if (shellWalletState === 'locked' && identity === 'declared') {")
	})

	it('enters the local home on the public address for a locked or unlocked account when the capability is missing', () => {
		expect(gate).toContain("if (identity !== 'declared' && (native.status === 'locked' || native.status === 'unlocked') && 'eoa' in native) {")
		const at = gate.indexOf("if (identity !== 'declared' && (native.status === 'locked'")
		expect(gate.slice(at, at + 200)).toContain('applyLocalWallet(native.eoa)')
	})

	it('never reads the native address for the local home when the capability is missing, and never shows the import page for it', () => {
		expect(gate).toContain("identity !== 'declared' ? '' : await readWalletEoaAddress()")
		expect(gate).toContain('if (identity === \'missing\') showStorageUnavailable(IDENTITY_CAPABILITY_MISSING)')
	})
});
