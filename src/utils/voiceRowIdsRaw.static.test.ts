/**
 * the rows written from a native call event and from the gossip offer keep the ids as they were sent. A row never
 * takes the other id's value (no callId-for-sessionId fallback), and the gossip offer path needs non-blank ids (as the intake
 * functions do). The in-memory matching and the control fallbacks are unchanged. Reads source files only.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8')
const chat = fs.readFileSync(path.join(SRC, 'pages', 'chat', 'chat.tsx'), 'utf8')
const session = fs.readFileSync(path.join(SRC, 'utils', 'voiceCallSession.ts'), 'utf8')

describe('row ids', () => {
	it('App.tsx native terminal row keeps the sent ids; no id is taken from the other field', () => {
		expect(app).toContain("callId: rowCallId || existing?.callId || offerAtEvent?.callId || '',")
		expect(app).toContain("sessionId: rowSessionId || existing?.sessionId || offerAtEvent?.sessionId || '',")
		expect(app).not.toContain('offerAtEvent?.sessionId || callId')
		expect(app).not.toContain('offerAtEvent?.callId || sessionId')
	})

	it('App.tsx gossip offer path needs non-blank callId and sessionId before a row is built', () => {
		expect(app).toContain("typeof signal.callId === 'string' && signal.callId.length > 0 &&")
		expect(app).toContain("typeof signal.sessionId === 'string' && signal.sessionId.length > 0 &&")
	})

	it('chat.tsx native reject row keeps the sent ids; no id is taken from the other field', () => {
		expect(chat).toContain("callId: rowCallId || previous?.callId || '',")
		expect(chat).toContain("sessionId: rowSessionId || previous?.sessionId || '',")
		expect(chat).not.toContain('previous?.sessionId || callId')
	})

	it('the row merge writes the ids untrimmed', () => {
		expect(session).toContain('callId: storedId(incoming.callId) || storedId(current.callId),')
		expect(session).toContain('sessionId: storedId(incoming.sessionId) || storedId(current.sessionId),')
	})

	it('-: chat.tsx compares call ids with sameCallId (both non-empty, exact) at the offer, dial and active-call lookups', () => {
		expect(chat).toContain('sameCallId(item.sessionId, incoming.sessionId)')
		expect(chat).toContain('sameCallId(item.sessionId, outgoing?.sessionId)')
		expect(chat).toContain('sameCallId(item.sessionId, activeVoiceSessionId)')
		expect(chat).not.toContain('item.sessionId === incoming.sessionId')
		expect(chat).not.toContain('item.sessionId === outgoing?.sessionId')
		expect(chat).not.toContain('item.sessionId === activeVoiceSessionId')
	})

	it('-: the incoming-offer guard in chat.tsx requires both ids to have length above 0', () => {
		expect(chat).toContain("typeof signal.callId === 'string' && signal.callId.length > 0 &&")
		expect(chat).toContain("typeof signal.sessionId === 'string' && signal.sessionId.length > 0 &&")
	})
})
