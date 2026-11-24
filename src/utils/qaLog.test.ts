/**
 * @jest-environment node
 */
import { qaLine, qaSendStage, qaTakeSendStage, qaErrorCode } from './qaLog'

const ORIGINAL = process.env.REACT_APP_QA_BRIDGE_COUNTER
afterEach(() => {
	process.env.REACT_APP_QA_BRIDGE_COUNTER = ORIGINAL
	jest.restoreAllMocks()
})

describe('QA log lines', () => {
	it('log nothing in a build without the QA flag', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = ''
		const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		qaLine('[send]', 'failed stage=no_nodes ms=5')
		qaSendStage('no_route')
		expect(spy).not.toHaveBeenCalled()
		expect(qaTakeSendStage()).toBe('')
	})
	it('keep a prefix and only [A-Za-z0-9 _.:=/-], at most 150 characters of text', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
		qaLine('[persist]', 'saved chats=3 messages=12 0xAbC@d#e')
		expect(spy).toHaveBeenCalledWith('[persist] saved chats=3 messages=12 0xAbC?d?e')
		qaLine('[send]', 'x'.repeat(400))
		expect((spy.mock.calls[1][0] as string).length).toBe('[send] '.length + 150)
	})
	it('hand the early-exit code to the failure line once', () => {
		process.env.REACT_APP_QA_BRIDGE_COUNTER = 'true'
		qaSendStage('no_entry')
		expect(qaTakeSendStage()).toBe('no_entry')
		expect(qaTakeSendStage()).toBe('')
	})
	it('prints the code of a `code: detail` error message and never the detail', () => {
		expect(qaErrorCode(new Error('pgp_field_not_allowed: profiles[].chats[].chatData.publicArmored'))).toBe('pgp_field_not_allowed')
		expect(qaErrorCode(new Error('chats_floor'))).toBe('chats_floor')
		expect(qaErrorCode(new Error('Failed to execute put on IDBObjectStore'))).toBe('other')
	})
})
