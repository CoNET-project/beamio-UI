/**
 * Y.61 shell registration answers, page side. Vector ids RA-01–06 come from the fixture copied from
 * pgp-migration-vectors.v2.json (sha256 in the fixture). Each RA id is asserted against the page judge, not restated here.
 * Tests named "page-local" cover the page's own fail-closed rules and are not spec vectors.
 */
import fixture from './__fixtures__/pgp-upgrade-ra-pu.v2.json'
import { judgeNativeRegisterResult, submitNativeChatRouteRegister, NATIVE_RESULT_KEYS } from './chatRouteRegister'
import { judgeRouteAck, NATIVE_ROUTE_ERROR_CODES } from './nativeChatRouteRegister'

type Entry = { id: string; input: { code: string }; expect: { type: string; ok: boolean; result?: { code: string }; error?: string } }
const entry = (id: string): Entry => {
	const e = (fixture.entries as Entry[]).find((x) => x.id === id)
	if (!e) throw new Error(`fixture missing ${id}`)
	return e
}

const fourFieldResult = (): Record<string, unknown> => {
	const r: Record<string, unknown> = {}
	for (const k of NATIVE_RESULT_KEYS) r[k] = k === 'timestamp' ? 1763251200000 : `v-${k}`
	return r
}

describe('Y.61 shell registration answers (RA-01–06, page side)', () => {
	// CRA resets mock implementations before each test, so the post stub is built inside beforeEach.
	let post: jest.Mock<Promise<{ ok: boolean }>, [Record<string, unknown>]>
	beforeEach(() => {
		post = jest.fn(async (_body: Record<string, unknown>) => ({ ok: true }))
	})

	it('RA-01 submitted: ack ok:true, result only {code:"submitted"}; the page posts nothing', async () => {
		const e = entry('RA-01')
		const ack = { type: 'ack', ok: true, result: e.expect.result }
		const outcome = judgeRouteAck(ack)
		expect(outcome).toEqual({ ok: true, submitted: true })
		expect(await submitNativeChatRouteRegister(outcome, post)).toEqual({ ok: true })
		expect(post).not.toHaveBeenCalled()
	})

	const failureIds = ['RA-02', 'RA-03', 'RA-04', 'RA-05', 'RA-06']
	for (const id of failureIds) {
		it(`${id} failure ack: error code only; the page ends closed and posts nothing`, async () => {
			const e = entry(id)
			const code = e.input.code
			expect(e.expect.error).toBe(code)
			expect((NATIVE_ROUTE_ERROR_CODES as readonly string[]).includes(code)).toBe(true)
			const outcome = judgeRouteAck({ type: 'ack', ok: false, error: code })
			expect(outcome).toEqual({ ok: false, code })
			expect(await submitNativeChatRouteRegister(outcome, post)).toEqual({ ok: false, reason: `native_${code}` })
			expect(post).not.toHaveBeenCalled()
		})
	}

	it('page-local: a submitted result with an extra field is bad_ack, not submitted, and posts nothing', async () => {
		const outcome = judgeRouteAck({ type: 'ack', ok: true, result: { code: 'submitted', nonce: '0x1' } })
		expect(outcome.ok).toBe(true)
		expect(judgeNativeRegisterResult({ code: 'submitted', nonce: '0x1' })).toBe('bad_ack')
		expect(await submitNativeChatRouteRegister(outcome, post)).toEqual({ ok: false, reason: 'native_bad_ack' })
		expect(post).not.toHaveBeenCalled()
	})

	it('page-local (compatibility): the old four-field-plus-signature answer is still posted by the page', async () => {
		const outcome = judgeRouteAck({ type: 'ack', ok: true, result: fourFieldResult() })
		expect(outcome.ok).toBe(true)
		expect(await submitNativeChatRouteRegister(outcome, post)).toEqual({ ok: true })
		expect(post).toHaveBeenCalledTimes(1)
	})

	it('page-local: an unknown error code is bad_ack and posts nothing', async () => {
		const outcome = judgeRouteAck({ type: 'ack', ok: false, error: 'something_else' })
		expect(outcome).toEqual({ ok: false, code: 'bad_ack' })
		expect(await submitNativeChatRouteRegister(outcome, post)).toEqual({ ok: false, reason: 'native_bad_ack' })
		expect(post).not.toHaveBeenCalled()
	})
})
