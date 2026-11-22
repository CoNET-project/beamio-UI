/**
 * v4 write path: shellRecordWrite answers not_ready only (no persistent form). A retryable
 * not_ready is re-written at most five times on the ladder 0.5, 1, 2, 4, 8 s, then the explicit error (the intent is kept; the user retries).
 * A non-retryable not_ready is the explicit error at once. Nothing is cleared, replaced, re-keyed or created by this path.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { isWriteRefusalCode, legacyRetryable, nextNotReadyState, parseShellRecordWrite, notReadyWriteStep, writeFailureDisposition, writeNotReadyReason } from './shellRecordStore'
import { NOT_READY_BOUNDED_DELAYS_MS } from './shellStoreWait'

describe('the write path: parse of the not_ready answer', () => {
	it('ok:true result.code not_ready with retryable true carries the class fields', () => {
		const p = { type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true } }
		expect(parseShellRecordWrite(p)).toMatchObject({ status: 'error', reason: 'not_ready', notReady: { retryable: true, notReadyReason: 'g1_uninitialized' } })
		expect(writeNotReadyReason(parseShellRecordWrite(p) as never)).toBe('shell_record_not_ready_bounded')
	})
	it('ok:true result.code not_ready with retryable false is the zero class: explicit at once', () => {
		const p = { type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'storage_locked', retryable: false } }
		expect(writeNotReadyReason(parseShellRecordWrite(p) as never)).toBe('shell_record_not_ready_zero')
	})
	it('the superseded envelope not_ready follows (the reason decides; without fields it is bounded)', () => {
		expect(writeNotReadyReason(parseShellRecordWrite({ type: 'ack', ok: false, error: 'not_ready', retryable: false }) as never)).toBe('shell_record_not_ready_zero')
		expect(writeNotReadyReason(parseShellRecordWrite({ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'storage_locked' }) as never)).toBe('shell_record_not_ready_zero')
		expect(writeNotReadyReason(parseShellRecordWrite({ type: 'ack', ok: false, error: 'not_ready' }) as never)).toBe('shell_record_not_ready_bounded')
	})
	it('a non-boolean retryable on the result is zero (never endless)', () => {
		const p = { type: 'ack', ok: true, result: { code: 'not_ready', retryable: 'yes' } }
		expect(writeNotReadyReason(parseShellRecordWrite(p) as never)).toBe('shell_record_not_ready_zero')
	})
	it('the write answers ok and conflict are unchanged', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: true, result: { code: 'ok', rev: 3 } })).toEqual({ status: 'ok', rev: 3 })
		expect(parseShellRecordWrite({ type: 'ack', ok: true, result: { code: 'conflict', currentRev: 4 } })).toEqual({ status: 'conflict', currentRev: 4 })
	})
	it('a non-not_ready failure gives no not_ready reason', () => {
		expect(writeNotReadyReason({ reason: 'bad_request' })).toBeNull()
	})
})

describe('the write ceiling', () => {
	it('the f-th consecutive not_ready failure re-writes after 0.5, 1, 2, 4, 8 s (five re-writes)', () => {
		const delays: number[] = []
		for (let f = 1; f <= 5; f++) {
			const step = notReadyWriteStep(f, 'bounded')
			expect(step.kind).toBe('retry')
			if (step.kind === 'retry') delays.push(step.delayMs)
		}
		expect(delays).toEqual([500, 1000, 2000, 4000, 8000])
		expect([...NOT_READY_BOUNDED_DELAYS_MS]).toEqual(delays)
	})
	it('the sixth consecutive failure is the explicit error: no sixth automatic re-write', () => {
		expect(notReadyWriteStep(6, 'bounded')).toEqual({ kind: 'explicit' })
		expect(notReadyWriteStep(99, 'bounded')).toEqual({ kind: 'explicit' })
	})
	it('the zero and persistent classes are the explicit error at once', () => {
		expect(notReadyWriteStep(1, 'zero')).toEqual({ kind: 'explicit' })
		expect(notReadyWriteStep(1, 'persistent')).toEqual({ kind: 'explicit' })
	})
	it('an invalid count is explicit, never an endless retry', () => {
		expect(notReadyWriteStep(0, 'bounded')).toEqual({ kind: 'explicit' })
		expect(notReadyWriteStep(Number.NaN, 'bounded')).toEqual({ kind: 'explicit' })
	})
})

describe('the superseded envelope helper is shared with the read path', () => {
	it('legacyRetryable: the envelope boolean wins; then the reason; then bounded', () => {
		expect(legacyRetryable({ retryable: false })).toBe(false)
		expect(legacyRetryable({ notReadyReason: 'ambiguous_accounts' })).toBe(false)
		expect(legacyRetryable({ notReadyReason: 'g1_uninitialized' })).toBe(true)
		expect(legacyRetryable({})).toBe(true)
	})
})

describe('(b): ten consecutive not_ready writes are not converted to persistent', () => {
	it('the ten consecutive failures: five re-writes, then the explicit error; never a persistent class', () => {
		const steps = []
		for (let f = 1; f <= 10; f++) steps.push(notReadyWriteStep(f, 'bounded').kind)
		expect(steps).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'explicit', 'explicit', 'explicit', 'explicit', 'explicit'])
	})
	it('a write not_ready answer never yields the persistent class (the write has no persistent form)', () => {
		const answers = [
			{ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true } },
			{ type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'storage_locked', retryable: false } },
			{ type: 'ack', ok: false, error: 'not_ready', notReadyReason: 'g1_uninitialized' },
			{ type: 'ack', ok: true, result: { code: 'error', sub: 'not_ready_persistent' } },
		]
		for (const a of answers) expect(String(writeNotReadyReason(parseShellRecordWrite(a) as never))).not.toMatch(/persistent/)
	})
})

describe('(c): a bounded write not_ready is re-written on the ladder; non-retryable is explicit at once', () => {
	it('the first re-write is 0.5 s and the fifth is 8 s', () => {
		expect(notReadyWriteStep(1, 'bounded')).toEqual({ kind: 'retry', delayMs: 500 })
		expect(notReadyWriteStep(5, 'bounded')).toEqual({ kind: 'retry', delayMs: 8000 })
	})
	it('the write paths route not_ready to the ceiling (direct paths defer, the deferred retry counts)', () => {
		const src = readFileSync(join(__dirname, 'shellRecordStore.ts'), 'utf8')
		expect((src.match(/deferNotReadyWrite\(/g) ?? []).length).toBeGreaterThanOrEqual(4)
		expect(src).toContain('notReadyFailure(pending, notReadyClass(')
	})
})

describe('the envelope refusals are never retried', () => {
	it('bad_request (including an over-size request), pgp_private_in_payload and origin_refused are refusals', () => {
		expect(isWriteRefusalCode('bad_request')).toBe(true)
		expect(isWriteRefusalCode('pgp_private_in_payload')).toBe(true)
		expect(isWriteRefusalCode('origin_refused')).toBe(true)
	})
	it('a not_ready is not a refusal (it is the ceiling, not a stop)', () => {
		expect(isWriteRefusalCode('not_ready')).toBe(false)
	})
})

describe('parse level: an envelope refusal keeps its code and is never retried', () => {
	it('ok:false bad_request returns the reason bad_request (not native_unavailable)', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: false, error: 'bad_request' })).toEqual({ status: 'error', reason: 'bad_request' })
	})
	it('ok:false origin_refused returns the reason origin_refused', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: false, error: 'origin_refused' })).toEqual({ status: 'error', reason: 'origin_refused' })
	})
	it('ok:false pgp_private_in_payload returns the reason pgp_private_in_payload', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: false, error: 'pgp_private_in_payload' })).toEqual({ status: 'error', reason: 'pgp_private_in_payload' })
	})
	it('an envelope without a string error is native_unavailable', () => {
		expect(parseShellRecordWrite({ type: 'ack', ok: false })).toEqual({ status: 'error', reason: 'native_unavailable' })
	})
	it('the chain: each refusal envelope parses to a refusal disposition on every path, never a retry', () => {
		for (const error of ['bad_request', 'origin_refused', 'pgp_private_in_payload']) {
			const parsed = parseShellRecordWrite({ type: 'ack', ok: false, error })
			expect(parsed.status).toBe('error')
			expect(writeFailureDisposition(parsed.status === 'error' ? parsed.reason : '')).toBe('refused')
		}
	})
})

describe('the disposition of a failed write (one classifier, used by the deferred retry)', () => {
	it('refusals are refused, not_ready is the ceiling, anything else keeps the ordinary backoff', () => {
		expect(writeFailureDisposition('bad_request')).toBe('refused')
		expect(writeFailureDisposition('origin_refused')).toBe('refused')
		expect(writeFailureDisposition('key_shaped_content')).toBe('refused')
		expect(writeFailureDisposition('shell_record_not_ready_bounded')).toBe('not_ready')
		expect(writeFailureDisposition('shell_record_not_ready_zero')).toBe('not_ready')
		expect(writeFailureDisposition('native_unavailable')).toBe('retry')
	})
})

describe('behaviour: a run of consecutive write not_ready answers', () => {
	const answer = { type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'g1_uninitialized', retryable: true } }
	it('ten consecutive retryable not_ready writes: five re-writes on the ladder, then the explicit error; never a persistent reason', () => {
		let count = 0
		const delays: number[] = []
		let explicitAt: number | null = null
		const reasons: string[] = []
		for (let i = 1; i <= 10; i++) {
			const reason = writeNotReadyReason(parseShellRecordWrite(answer) as never) as string
			reasons.push(reason)
			const cls = reason.slice('shell_record_not_ready_'.length) as 'bounded'
			const next = nextNotReadyState(count, cls)
			count = next.count
			if (next.step.kind === 'retry') delays.push(next.step.delayMs)
			else if (explicitAt === null) explicitAt = i
		}
		expect(delays).toEqual([500, 1000, 2000, 4000, 8000])
		expect(explicitAt).toBe(6)
		expect(reasons.every((r) => r === 'shell_record_not_ready_bounded')).toBe(true)
		expect(reasons.some((r) => r.includes('persistent'))).toBe(false)
	})
	it('a non-retryable not_ready is the explicit error at the first failure', () => {
		const zero = { type: 'ack', ok: true, result: { code: 'not_ready', notReadyReason: 'storage_locked', retryable: false } }
		const reason = writeNotReadyReason(parseShellRecordWrite(zero) as never) as string
		expect(nextNotReadyState(0, reason.slice('shell_record_not_ready_'.length) as 'zero').step).toEqual({ kind: 'explicit' })
	})
	it('after the explicit error the user retry starts a fresh ladder (count reset to zero)', () => {
		expect(nextNotReadyState(0, 'bounded').step).toEqual({ kind: 'retry', delayMs: 500 })
	})
})

