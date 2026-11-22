/** The shell passcode entry is operable only when wallet.passcode.v1 is declared (fail closed). SYNTHETIC values only. */
import { passcodeEntryOperable } from './passcodeEntryGate'

describe('passcodeEntryOperable (fail closed)', () => {
	it('no answer, null or undefined: not operable', () => {
		expect(passcodeEntryOperable(null)).toBe(false)
		expect(passcodeEntryOperable(undefined)).toBe(false)
	})
	it('an empty or malformed list: not operable', () => {
		expect(passcodeEntryOperable([])).toBe(false)
		expect(passcodeEntryOperable('wallet.passcode.v1' as unknown as string[])).toBe(false)
	})
	it('only the native-keys capability: not operable (a different capability does not count)', () => {
		expect(passcodeEntryOperable(['identity.native-keys.v1'])).toBe(false)
	})
	it('wallet.passcode.v1 declared: operable', () => {
		expect(passcodeEntryOperable(['identity.native-keys.v1', 'wallet.passcode.v1'])).toBe(true)
	})
})
