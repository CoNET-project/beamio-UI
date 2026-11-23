/**
 * @jest-environment node
 *
 * HC-LOCK L-PRE (v10 §3.2 nativeMnemonicPreread): a locked pre-read is `locked`, not absent and not an unknown timeout.
 */
import { prereadFromAnswer } from './nativeRecovery'

describe('mnemonic pre-read locked (L-PRE)', () => {
	it('an ack error locked is the locked kind', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'locked' } })).toEqual({ kind: 'locked' })
	})

	it('regression: absent stays absent; a refusal of another kind stays unknown; unknown_command stays unsupported', () => {
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: true, result: { code: 'confirmed_missing' } } })).toEqual({ kind: 'absent' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'not_ready' } })).toEqual({ kind: 'unknown', reason: 'not_ready' })
		expect(prereadFromAnswer({ kind: 'payload', payload: { type: 'ack', ok: false, error: 'unknown_command' } })).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})
})
