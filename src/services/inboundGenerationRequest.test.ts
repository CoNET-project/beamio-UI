/**
 * @jest-environment node
 *
 * the page side of the requests that carry the inbound generation (send, group text, mailbox command).
 * Vector ids to (identity-guard-vectors.v1.json, fourth version, sha256 805b1e43). SYNTHETIC values.
 *
 * Not modelled: the clock. The wait is an injected answer (`timeout`, or an ack), so the 30-second rule is checked as the value passed
 * on. The native-side stage checks ( to: before the signature, before the POST, before the reply) run in the native layer;
 * here the page sees only silence, and the page-side rule for silence is what is tested.
 * (an old page without deferAck) is a native rule for pages that do not declare the capability; this page always declares it.
 */
import {
	GENERATION_WAIT_MS,
	GenerationRefusal,
	withInboundGeneration,
	requestWithInboundGeneration,
	type GenerationAttemptAnswer,
	type GenerationRequestDeps,
} from './inboundGenerationRequest'

const ACK_OK: GenerationAttemptAnswer = { kind: 'ack', ok: true, result: { sent: true } }
const TIMEOUT: GenerationAttemptAnswer = { kind: 'timeout' }

/** A scripted page: each send consumes the next answer. `onSend` may move the generation first. */
function script(answers: Array<GenerationAttemptAnswer | ((n: number) => GenerationAttemptAnswer)>, start: unknown = 2) {
	const sent: Array<Record<string, unknown>> = []
	const waits: number[] = []
	let gen: unknown = start
	const deps: GenerationRequestDeps = {
		generation: () => gen,
		send: async (cmd, timeoutMs) => {
			sent.push(cmd)
			waits.push(timeoutMs)
			const next = answers[sent.length - 1]
			return typeof next === 'function' ? next(sent.length) : next
		},
	}
	return {
		deps,
		sent,
		waits,
		setGeneration: (v: unknown) => {
			gen = v
		},
	}
}

/** The command a page builds for a send, a group text or a mailbox command: the field is at the top level. */
const build = (kind: string) => (inboundGeneration: number | undefined) =>
	withInboundGeneration({ type: kind, payload: 'x' }, inboundGeneration)

describe('and: the new page always carries the field ', () => {
	it('the page builds the command with the field at the top level; a native refusal for a missing field is returned, not resent', async () => {
		const s = script([{ kind: 'ack', ok: false, reason: 'bad_request' }])
		const out = await requestWithInboundGeneration(build('send'), s.deps)
		expect(out).toEqual({ ok: false, reason: 'bad_request' })
		expect(s.sent).toHaveLength(1)
		expect(Object.keys(s.sent[0]).sort()).toEqual(['inboundGeneration', 'payload', 'type'])
	})

	it('a field of the wrong type is bad_request; nothing is sent', async () => {
		const s = script([ACK_OK], '2')
		await expect(requestWithInboundGeneration(build('group'), s.deps)).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(s.sent).toEqual([])
	})

	it('nothing announced yet: native_unavailable, nothing sent ', async () => {
		const s = script([ACK_OK], null)
		await expect(requestWithInboundGeneration(build('mailboxCommand'), s.deps)).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(s.sent).toEqual([])
	})

	it('a refusal while building the command is returned before anything is sent', async () => {
		const s = script([ACK_OK])
		await expect(
			requestWithInboundGeneration(() => {
				throw new GenerationRefusal('bad_request')
			}, s.deps),
		).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(s.sent).toEqual([])
	})
})

describe('to: a request the native layer drops is silent; the page times out ', () => {
	it('silence after the generation advanced: abandoned at once, nothing re-sent, no reply', async () => {
		const s = script([
			(n) => {
				expect(n).toBe(1)
				s.setGeneration(3)
				return TIMEOUT
			},
			ACK_OK,
		])
		await expect(requestWithInboundGeneration(build('send'), s.deps)).resolves.toEqual({ ok: false, reason: 'generation_expired' })
		expect(s.sent).toHaveLength(1)
		expect(s.sent[0].inboundGeneration).toBe(2)
	})

	it.each(['encrypt_failed', 'wrap_failed'])(
		'%s: the native layer never answers an expired request, so the page sees silence and abandons it',
		async () => {
			const s = script([
				(n) => {
					expect(n).toBe(1)
					s.setGeneration(3)
					return TIMEOUT
				},
				ACK_OK,
			])
			await expect(requestWithInboundGeneration(build('group'), s.deps)).resolves.toEqual({ ok: false, reason: 'generation_expired' })
			expect(s.sent).toHaveLength(1)
		},
	)
})

describe('a valid generation with an in-flight request over 30 s ', () => {
	it('the page waits 30 s; the request is silent on the page; the generation has not moved, so it is resent once', async () => {
		const s = script([TIMEOUT, ACK_OK])
		const out = await requestWithInboundGeneration(build('send'), s.deps)
		expect(out).toEqual({ ok: true, result: { sent: true } })
		expect(s.waits).toEqual([GENERATION_WAIT_MS, GENERATION_WAIT_MS])
		expect(s.sent.map((c) => c.inboundGeneration)).toEqual([2, 2])
	})

	it('a send_timeout answer for the current attempt is a failure, and is not resent ', async () => {
		const s = script([{ kind: 'ack', ok: false, reason: 'send_timeout' }])
		await expect(requestWithInboundGeneration(build('send'), s.deps)).resolves.toEqual({ ok: false, reason: 'send_timeout' })
		expect(s.sent).toHaveLength(1)
	})

	it('after the resend the native layer also times out: the page gives up with timeout, after one resend only', async () => {
		const s = script([TIMEOUT, TIMEOUT])
		await expect(requestWithInboundGeneration(build('mailboxCommand'), s.deps)).resolves.toEqual({ ok: false, reason: 'timeout' })
		expect(s.sent).toHaveLength(2)
	})

	it('the resend is built fresh (the builder runs again) and carries the same generation', async () => {
		const s = script([TIMEOUT, ACK_OK])
		let builds = 0
		await requestWithInboundGeneration(
			(g) => {
				builds += 1
				return { type: 'send', n: builds, inboundGeneration: g }
			},
			s.deps,
		)
		expect(builds).toBe(2)
		expect(s.sent.map((c) => c.n)).toEqual([1, 2])
		expect(s.sent.map((c) => c.inboundGeneration)).toEqual([2, 2])
	})

	it('a generation that moves during the resend wait abandons the request (no third attempt)', async () => {
		const s = script([
			TIMEOUT,
			(n) => {
				expect(n).toBe(2)
				s.setGeneration(3)
				return TIMEOUT
			},
		])
		await expect(requestWithInboundGeneration(build('send'), s.deps)).resolves.toEqual({ ok: false, reason: 'generation_expired' })
		expect(s.sent).toHaveLength(2)
	})

	it('the same wait, answered inside 30 s): accepted, nothing resent', async () => {
		const s = script([ACK_OK])
		await expect(requestWithInboundGeneration(build('send'), s.deps)).resolves.toEqual({ ok: true, result: { sent: true } })
		expect(s.sent).toHaveLength(1)
	})
})

describe('and at the page: a roster or tombstone whose field has the wrong type is refused before sending ', () => {
	it.each(['issueGroupRoster', 'issueGroupTombstone'])('%s with a string generation: bad_request, nothing signed or sent', async (kind) => {
		const s = script([ACK_OK], '2')
		await expect(requestWithInboundGeneration(build(kind), s.deps)).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(s.sent).toEqual([])
	})
})

