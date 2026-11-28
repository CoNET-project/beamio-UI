// the result mapping of a delivery attempt and the trust-hold rule (sendResultMapping.ts).
import { heldSettleOf, isUserHeldCode, isUserHeldMessage, mapDeliverFailure, resumeEntryOf, statusAfterPostAnswered } from './sendResultMapping'
import { failedRetryPlan } from './failedRetry'

describe('mapDeliverFailure', () => {
	it('route_unconfirmed (the route could not be read) and every network-class code are retryable failures', () => {
		for (const code of ['route_unconfirmed', 'network_error', 'send_failed', 'recipient_no_record', 'recipient_key_unavailable', 'identity_not_ready', undefined, null, '']) {
			expect(mapDeliverFailure(code)).toEqual({ kind: 'failed' })
		}
	})
	it('only the trust holds wait for the user', () => {
		expect(mapDeliverFailure('fingerprint_changed')).toEqual({ kind: 'held' })
		expect(mapDeliverFailure('first_fetch_pending')).toEqual({ kind: 'held' })
		expect(isUserHeldCode('route_unconfirmed')).toBe(false)
	})
})

describe('isUserHeldMessage', () => {
	it('a message held for a trust decision (by status or by error) is held; route_unconfirmed and failed are not', () => {
		expect(isUserHeldMessage({ status: 'fingerprint_changed' })).toBe(true)
		expect(isUserHeldMessage({ status: 'failed', sendError: 'first_fetch_pending' })).toBe(true)
		expect(isUserHeldMessage({ status: 'route_unconfirmed', sendError: 'route_unconfirmed' })).toBe(false)
		expect(isUserHeldMessage({ status: 'failed', sendError: 'interrupted' })).toBe(false)
		expect(isUserHeldMessage({ status: 'sending' })).toBe(false)
	})
})

describe('failedRetryPlan accepts route_unconfirmed', () => {
	const base = { from: 'me' as const, text: 'hello', sendId: 'sid-1', createdAt: 1 }
	it('a failed and a route_unconfirmed message are resent from their text; anything else is kept as it is', () => {
		expect(failedRetryPlan({ ...base, status: 'failed' }).kind).toBe('resend')
		expect(failedRetryPlan({ ...base, status: 'route_unconfirmed' }).kind).toBe('resend')
		expect(failedRetryPlan({ ...base, status: 'sent' }).kind).toBe('keep')
		expect(failedRetryPlan({ ...base, status: 'fingerprint_changed' }).kind).toBe('keep')
	})
})

describe('statusAfterPostAnswered: the status never goes back', () => {
	it('a message that is already delivered (the receipt came first) stays delivered; everything else becomes sent', () => {
		expect(statusAfterPostAnswered('delivered')).toBe('delivered')
		for (const s of ['sending', 'failed', 'route_unconfirmed', 'sent', undefined]) expect(statusAfterPostAnswered(s)).toBe('sent')
	})
})

describe('resumeEntryOf, the first decision of the resume (table)', () => {
	const T = true
	const F = false
	// [evidenceInMemory, evidenceOnDisk, chatReady, messageInList] -> entry
	const table: Array<[boolean, boolean, boolean, boolean, string]> = [
		[F, T, F, T, 'apply_evidence'], // THE cell: the chat crypto is not ready, evidence on disk, the message is in the list: release
		[T, F, F, T, 'apply_evidence'],
		[F, T, F, F, 'apply_evidence'], // evidence but no message yet: applied (the item stays confirmed, nothing is resent)
		[F, T, T, T, 'apply_evidence'],
		[F, T, T, F, 'apply_evidence'],
		[T, T, T, T, 'apply_evidence'],
		[T, T, F, F, 'apply_evidence'],
		[F, F, F, T, 'chat_not_ready'],
		[F, F, F, F, 'chat_not_ready'],
		[F, F, T, F, 'message_not_in_list'],
		[F, F, T, T, 'continue'],
	]
	it.each(table)('memory %s, disk %s, chat ready %s, message in list %s -> %s', (evidenceInMemory, evidenceOnDisk, chatReady, messageInList, expected) => {
		expect(resumeEntryOf({ evidenceInMemory, evidenceOnDisk, chatReady, messageInList })).toBe(expected)
	})
	it('the table is complete: all 16 combinations are decided, and evidence always wins over both guards', () => {
		let n = 0
		for (const a of [F, T]) for (const b of [F, T]) for (const c of [F, T]) for (const d of [F, T]) {
			n += 1
			const e = resumeEntryOf({ evidenceInMemory: a, evidenceOnDisk: b, chatReady: c, messageInList: d })
			expect(['apply_evidence', 'chat_not_ready', 'message_not_in_list', 'continue']).toContain(e)
			if (a || b) expect(e).toBe('apply_evidence')
		}
		expect(n).toBe(16)
	})
})

describe('heldSettleOf, what the queue does after a HELD retry (table)', () => {
	const bound = { kind: 'bound' as const, digest: '0xabc' }
	const empty = { kind: 'legacy_empty' as const, digest: '0xabc' }
	const run = async (input: { ok: boolean; code?: string | null; receipt: typeof bound | typeof empty | null; persisted: boolean; copy: boolean }) => {
		const asked: boolean[] = []
		const result = await heldSettleOf({ ok: input.ok, code: input.code, receipt: input.receipt, persisted: input.persisted, ackCopy: async (p) => { asked.push(p); return input.copy } })
		return { result, asked }
	}
	it('the send failed: network or non-2xx is a retryable failure; route_unconfirmed is retryable too; the trust holds stay held for the user', async () => {
		expect((await run({ ok: false, code: 'send_failed', receipt: null, persisted: true, copy: true })).result).toEqual({ kind: 'failed' })
		expect((await run({ ok: false, code: 'route_unconfirmed', receipt: null, persisted: true, copy: true })).result).toEqual({ kind: 'failed' })
		expect((await run({ ok: false, code: undefined, receipt: null, persisted: true, copy: true })).result).toEqual({ kind: 'failed' })
		expect((await run({ ok: false, code: null, receipt: null, persisted: true, copy: true })).result).toEqual({ kind: 'failed' })
		for (const code of ['fingerprint_changed', 'first_fetch_pending']) expect((await run({ ok: false, code, receipt: null, persisted: true, copy: true })).result).toEqual({ kind: 'held' })
	})
	it('an ok WITHOUT a bound receipt (the empty 200, or no classification at all) is awaiting and never sent; the copy is not even asked for', async () => {
		for (const receipt of [empty, null]) {
			for (const persisted of [true, false]) {
				const r = await run({ ok: true, receipt, persisted, copy: true })
				expect(r.result).toEqual({ kind: 'awaiting', persisted })
				expect(r.asked).toEqual([])
			}
		}
	})
	it('a bound receipt with the copy safe: sent and persisted (the item leaves)', async () => {
		const r = await run({ ok: true, receipt: bound, persisted: true, copy: true })
		expect(r.result).toEqual({ kind: 'sent', persisted: true })
		expect(r.asked).toEqual([true])
	})
	it('a bound receipt but the copy is NOT safe (record write failed, or the library did not ACK): sent with persisted false: the item stays confirmed, only the persistence is retried', async () => {
		expect((await run({ ok: true, receipt: bound, persisted: true, copy: false })).result).toEqual({ kind: 'sent', persisted: false })
		const r = await run({ ok: true, receipt: bound, persisted: false, copy: false })
		expect(r.result).toEqual({ kind: 'sent', persisted: false })
		expect(r.asked).toEqual([false])
	})
	it('a failed send never asks for the copy and never reports sent, whatever the receipt says', async () => {
		const r = await run({ ok: false, code: 'send_failed', receipt: bound, persisted: true, copy: true })
		expect(r.result).toEqual({ kind: 'failed' })
		expect(r.asked).toEqual([])
	})
})
