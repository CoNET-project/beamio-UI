/**
 * Startup capability: only unknown_command means "this shell has no pre-read"; every other refusal or missing answer is
 * an unknown without that reason, and no unknown is ever absent. SYNTHETIC values only.
 */
import { prereadFromAnswer } from './nativeRecovery'

const ack = (p: Record<string, unknown>) => ({ kind: 'payload', payload: { type: 'ack', ...p } })

describe('pre-read unknown reasons (startup capability)', () => {
	it('unknown_command is the unsupported reason; the caller falls back instead of waiting', () => {
		expect(prereadFromAnswer(ack({ ok: false, error: 'unknown_command' }))).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})

	it('a timeout, a transport error, a refusal or a bad answer is a plain unknown, never absent and never unsupported', () => {
		for (const a of [
			{ kind: 'timeout' },
			{ kind: 'unavailable' },
			ack({ ok: false, error: 'stale_seq' }),
			ack({ ok: false, error: 'untrusted_source' }),
			ack({ ok: false, error: 'bad_request', result: { state: 'absent' } }),
		]) {
			const r = prereadFromAnswer(a)
			expect(r.kind).toBe('unknown')
			expect(r).not.toHaveProperty('reason')
		}
	})

	it('an explicit absent answer is absent (not unknown), so only a definite answer reaches the onboarding', () => {
		expect(prereadFromAnswer(ack({ ok: true, result: { state: 'absent' } }))).toEqual({ kind: 'absent' })
	})
})
