/**
 * @jest-environment node
 *
 * R-21 parse layer (spec §25.17.4): {type:'passcodeState', set, locked}. Malformed payloads are ignored.
 */
import { parsePasscodeStateEvent } from './passcodeStateWatch'

describe('passcodeState parse (R-21)', () => {
	it('reads a well-formed state', () => {
		expect(parsePasscodeStateEvent({ type: 'passcodeState', set: true, locked: false })).toEqual({ set: true, locked: false })
		expect(parsePasscodeStateEvent({ type: 'passcodeState', set: false, locked: true })).toEqual({ set: false, locked: true })
	})

	it('ignores other types and missing or non-boolean fields', () => {
		expect(parsePasscodeStateEvent({ type: 'ack', set: true, locked: false })).toBeNull()
		expect(parsePasscodeStateEvent({ type: 'passcodeState', set: 'yes', locked: false })).toBeNull()
		expect(parsePasscodeStateEvent({ type: 'passcodeState', set: true })).toBeNull()
		expect(parsePasscodeStateEvent(null)).toBeNull()
		expect(parsePasscodeStateEvent('passcodeState')).toBeNull()
	})
})
