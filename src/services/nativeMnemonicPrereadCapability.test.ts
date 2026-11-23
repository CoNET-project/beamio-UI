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

	it('a timeout or a transport error is a plain unknown with no reason, never absent and never unsupported', () => {
		for (const a of [{ kind: 'timeout' }, { kind: 'unavailable' }]) {
			expect(prereadFromAnswer(a)).toEqual({ kind: 'unknown' })
		}
	})

	it('a refusal or a bad answer is unknown with reason envelope_error and its closed code, never absent and never unsupported (unit b)', () => {
		// 改写依据：产品 prereadFromAnswer 对 ok:false 的信封拒绝返回 envelope_error 并携带 code；ack 中的 result:{state:'absent'} 在 ok:false 时不被采信
		for (const code of ['stale_seq', 'untrusted_source', 'bad_request']) {
			const r = prereadFromAnswer(ack({ ok: false, error: code, result: { state: 'absent' } }))
			expect(r).toEqual({ kind: 'unknown', reason: 'envelope_error', code })
			expect(r.kind).not.toBe('absent')
			expect(r).not.toEqual(expect.objectContaining({ reason: 'unsupported' }))
		}
	})

	it('a confirmed_missing code is the only absent (6678fa93, 45ada442 item 3)', () => {
		expect(prereadFromAnswer(ack({ ok: true, result: { code: 'confirmed_missing' } }))).toEqual({ kind: 'absent' })
	})

	it('the legacy state shape is not a confirmed absence: it is never absent and never onboarding (45ada442 item 3)', () => {
		const r = prereadFromAnswer(ack({ ok: true, result: { state: 'absent' } }))
		expect(r.kind).not.toBe('absent')
	})
})
