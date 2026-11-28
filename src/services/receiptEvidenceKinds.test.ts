/**
 * @jest-environment node
 */
// Which answers of an entry count as a receipt bound to the item. Synthetic values.
import { classifySendAnswer } from './sendAnswer'

const DIGEST = `0x${'cd'.repeat(32)}`
const H = `"h":"${DIGEST}"`

describe('a bound receipt must say what happened to the message: stored or duplicate, as the boolean true', () => {
	it.each([
		`{"ok":true,${H}}`,
		`{"ok":true,"stored":false,${H}}`,
		`{"ok":true,"duplicate":false,${H}}`,
		`{"ok":true,"stored":false,"duplicate":false,${H}}`,
		`{"ok":true,"stored":"true",${H}}`,
		`{"ok":true,"stored":1,${H}}`,
		`{"ok":true,"duplicate":"true",${H}}`,
		`{"ok":true,"duplicate":1,${H}}`,
		`{"ok":true,"stored":{},${H}}`,
		`{"ok":"true","stored":true,${H}}`,
		`{"ok":1,"stored":true,${H}}`,
	])('%s is not a receipt', (body) => { expect(classifySendAnswer(body, DIGEST)).toBe('reject') })
	it.each([`{"ok":true,"stored":true,${H}}`, `{"ok":true,"duplicate":true,${H}}`, `{"ok":true,"stored":false,"duplicate":true,${H}}`])('%s is a bound receipt', (body) => { expect(classifySendAnswer(body, DIGEST)).toBe('bound') })
	it('with another digest it is not ours', () => { expect(classifySendAnswer(`{"ok":true,"stored":true,"h":"0x${'ee'.repeat(32)}"}`, DIGEST)).toBe('reject') })
})
