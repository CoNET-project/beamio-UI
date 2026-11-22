/**
 * Static wiring check: a looked-up tag that differs from the declared tag after ringing revokes the ring.
 * The App and the chat page close their layers and the App records the call as cancelled. Reads the sources only.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('late tag mismatch revokes the ring (static)', () => {
	test('App: the ring branch calls the pure revoke helper and returns when revoked (behaviour is in voiceRingRevoke.test.ts)', () => {
		const app = read('App.tsx')
		const at = app.indexOf('revokeRingForLateTag(signal, tag, {')
		expect(at).toBeGreaterThan(-1)
		const block = app.slice(at, at + 1100)
		expect(block).toContain('dismissNative: (callId, sessionId) => dismissRevokedIncomingCall(callId, sessionId)')
		expect(block).toContain('markTerminal: (callId, sessionId) => markVoiceCallTerminal(callId, sessionId)')
		expect(block).toContain("new CustomEvent('beamio-incoming-ring-revoked'")
		expect(app).toContain("if (revoked) {")
		expect(app).toContain("window.addEventListener('beamio-incoming-ring-revoked', onRingRevoked)")
		expect(app).toContain("status: 'declined'")
	})
	test('chat page: closes its layer and does not report on a contradicting late lookup', () => {
		const chat = read('pages/chat/chat.tsx')
		const at = chat.indexOf('const declaredTagLater = claimedVoiceCallerTag(signal)')
		expect(at).toBeGreaterThan(-1)
		const block = chat.slice(at, at + 400)
		expect(block).toContain('setIncomingVoiceOffer(previous => sameCallId(previous?.sessionId, signal.sessionId) ? null : previous)')
		expect(block).toContain('return')
	})
})
