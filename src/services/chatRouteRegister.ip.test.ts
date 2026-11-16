/**
 * Y.64 submit verification, page side. The cases come from the fixture copied from pgp-migration-vectors.v2.json
 * (ipSubmitVerificationCases, sha256 in the fixture). The chain check itself (read-back, one retry) is executed by the gate on
 * the v2 vectors; this file checks only that the page maps each native answer the vector expects, and never treats a
 * non-submitted answer as a success or posts anything for it.
 */
import fixture from './__fixtures__/pgp-ip-submit.v2.json'
import { submitNativeChatRouteRegister } from './chatRouteRegister'
import { judgeRouteAck } from './nativeChatRouteRegister'

type Entry = { id: string; expect: { code: string; retried: boolean } }
const entries = fixture.entries as Entry[]

/** The native answer the vector's expected code corresponds to on the wire. */
const answerFor = (code: string): Record<string, unknown> =>
	code === 'submitted' ? { type: 'ack', ok: true, result: { code: 'submitted' } } : { type: 'ack', ok: false, error: code }

describe('Y.64 submit verification, page side (IP-01–07)', () => {
	let post: jest.Mock<Promise<{ ok: boolean }>, [Record<string, unknown>]>
	beforeEach(() => {
		post = jest.fn(async (_body: Record<string, unknown>) => ({ ok: true }))
	})

	it('the fixture has the seven IP ids', () => {
		expect(entries.map((e) => e.id)).toEqual(['IP-01', 'IP-02', 'IP-03', 'IP-04', 'IP-05', 'IP-06', 'IP-07'])
	})

	for (const e of entries) {
		it(`${e.id} expects ${e.expect.code}: the page maps the native answer and never posts for it`, async () => {
			const outcome = judgeRouteAck(answerFor(e.expect.code))
			const out = await submitNativeChatRouteRegister(outcome, post)
			if (e.expect.code === 'submitted') {
				expect(out).toEqual({ ok: true })
				expect(post).not.toHaveBeenCalled()
			} else {
				expect(outcome).toEqual({ ok: false, code: e.expect.code })
				expect(out).toEqual({ ok: false, reason: `native_${e.expect.code}` })
				expect(post).not.toHaveBeenCalled()
			}
		})
	}

	it('IP-02: unverified_submit is never reported as submitted', async () => {
		const out = await submitNativeChatRouteRegister(judgeRouteAck({ type: 'ack', ok: false, error: 'unverified_submit' }), post)
		expect(out.ok).toBe(false)
	})
})
