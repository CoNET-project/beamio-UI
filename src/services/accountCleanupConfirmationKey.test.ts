/**
 * v191 §211: the confirmation command's accountKey is the page-read, derived address (lower-case 0x + 40 hex); unreadable means no command.
 */
import { confirmationAccountKey } from './accountCleanupConfirmation'

const A = '0x' + 'a'.repeat(40)
describe('confirmationAccountKey', () => {
	it.each([
		[A, A],
		[A.toUpperCase().replace('0X', '0x'), A],
		['  ' + A + '  ', A],
	])('a readable address %s gives the lower-case key', (input, want) => {
		expect(confirmationAccountKey(input)).toBe(want)
	})
	const unreadable: Array<[string, unknown]> = [
		['null', null],
		['undefined', undefined],
		['empty', ''],
		['39 digits', '0x' + 'a'.repeat(39)],
		['non-hex', '0x' + 'g'.repeat(40)],
		['short', 'abc'],
		['not a string', 42],
	]
	for (const [why, input] of unreadable) {
		it(`an unreadable input (${why}) gives null: no confirmation command`, () => {
			expect(confirmationAccountKey(input)).toBeNull()
		})
	}
})
