/**
 * @jest-environment node
 *
 * The open-ack shapes (spec v3.12 §1; 2026-11-18 rule). not_ready is read from `error`, and `reason` is accepted too. The
 * already_bound path is the nested result event (ok:true page:none), covered here; the ok:false already_bound ack is a compatibility
 * branch only. Test IDs OS-1…OS-5 are my own naming.
 */
import { acceptNativeCreateResult, parseAccountCreateOpenAck } from './nativeRecovery'

describe('open ack shapes (OS)', () => {
	it('OS-1: ack ok:false error:not_ready reads not_ready (spec v3.12 §1)', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_ready' })).toMatchObject({ ok: false, reason: 'not_ready' })
	})

	it('OS-2: ack ok:false reason:not_ready also reads not_ready (compatibility)', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, reason: 'not_ready' })).toMatchObject({ ok: false, reason: 'not_ready' })
	})

	it('OS-3: error takes precedence over reason; neither gives bad_ack', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false, error: 'not_available', reason: 'not_ready' })).toMatchObject({ reason: 'not_available' })
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: false })).toMatchObject({ reason: 'bad_ack' })
	})

	it('OS-4: already_bound is the nested result event after ok:true page:none (ok:true open, then the result event)', () => {
		expect(parseAccountCreateOpenAck({ type: 'ack', ok: true, page: 'none' })).toEqual({ ok: true, page: 'none' })
		const nested = { type: 'nativeAccountCreateResult', reqId: 9, ok: false, result: { code: 'already_bound' } }
		expect(acceptNativeCreateResult(nested, 9)).toEqual({ code: 'already_bound' })
	})

	it('OS-5: lookup_unavailable is the nested result event after ok:true page:none', () => {
		const nested = { type: 'nativeAccountCreateResult', reqId: 9, ok: false, result: { code: 'lookup_unavailable' } }
		expect(acceptNativeCreateResult(nested, 9)).toEqual({ code: 'lookup_unavailable' })
	})
})
