/**
 * @jest-environment node
 *
 * the inbound generation the native layer announces, and the envelope and group signing that carries it.
 * Vector ids to (interface identity-guard-vectors.v1.json, third version, sha256 14136c03). Synthetic values only.
 *
 * Not modelled: the clock. The wait is an injected answer (`timeout` or an ack), so the 30-second rule is checked as the value passed on.
 * Not checked: that init's ack shape is unchanged ( `initAckChanged`); the shell's init is not run here.
 */
import {
	installInboundGenerationWatcher,
	latestInboundGeneration,
	recordInboundGenerationEvent,
	resetInboundGenerationForTests,
} from './inboundGeneration'
import { nativeSignWithGeneration, type GenerationSendAnswer, type GenerationSignDeps } from './nativeSigning'

type Win = EventTarget & Record<string, unknown>
const w = new EventTarget() as Win
;(globalThis as unknown as { window: Win }).window = w
class ShellCustomEvent extends Event {
	readonly detail: unknown
	constructor(type: string, init?: { detail?: unknown }) {
		super(type)
		this.detail = init?.detail
	}
}
;(globalThis as unknown as { CustomEvent: typeof ShellCustomEvent }).CustomEvent = ShellCustomEvent

const SIG = '0x' + 'ab'.repeat(65)
const flush = () => new Promise((r) => setTimeout(r, 0))

/** A scripted native layer: each send consumes the next answer; `onSend` may move the generation first. */
function script(answers: Array<GenerationSendAnswer | ((n: number) => GenerationSendAnswer)>) {
	const sent: Array<Record<string, unknown>> = []
	const waits: number[] = []
	let gen: unknown = 2
	const deps: GenerationSignDeps = {
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

const ACK_OK: GenerationSendAnswer = { kind: 'ack', ok: true, result: { signature: SIG } }
const TIMEOUT: GenerationSendAnswer = { kind: 'timeout' }

beforeEach(() => {
	resetInboundGenerationForTests()
})

describe('to: the native layer announces the generation ', () => {
	it('init succeeds, the event carries generation 1, and the page keeps it', async () => {
		const remove = installInboundGenerationWatcher()
		window.dispatchEvent(
			new CustomEvent('cashtreesios', { detail: { action: 'chatModuleEvent', event: { type: 'inboundGeneration', generation: 1 } } }),
		)
		await flush()
		expect(latestInboundGeneration()).toBe(1)
		remove?.()
	})

	it('a clear succeeds, the event carries 2, and the page holds 2', () => {
		expect(recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 1 })).toBe(true)
		expect(recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })).toBe(true)
		expect(latestInboundGeneration()).toBe(2)
	})

	it('a failed clear still advances the generation; the event carries 2, and the page holds 2', () => {
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 1 })
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 2 })
		expect(latestInboundGeneration()).toBe(2)
	})

	it('a value that is not a non-negative safe integer is ignored and never replaces a good one', () => {
		recordInboundGenerationEvent({ type: 'inboundGeneration', generation: 3 })
		for (const bad of ['3', 3.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN, null, undefined]) {
			expect(recordInboundGenerationEvent({ type: 'inboundGeneration', generation: bad as number })).toBe(false)
		}
		expect(latestInboundGeneration()).toBe(3)
	})

	it('other payloads are not generation events', () => {
		expect(recordInboundGenerationEvent({ type: 'ack', generation: 4 })).toBe(false)
		expect(recordInboundGenerationEvent(null)).toBe(false)
		expect(latestInboundGeneration()).toBeNull()
	})

	it('before any announcement, envelope and group signing is unavailable and nothing is sent', async () => {
		const s = script([ACK_OK])
		s.setGeneration(null)
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'native_unavailable' })
		expect(s.sent).toEqual([])
	})
})

describe('to: a silent native layer is a dropped request ', () => {
	it('no answer in 35 s and the generation is unchanged: resent once, with a freshly built message and the same generation', async () => {
		const s = script([TIMEOUT, ACK_OK])
		let builds = 0
		const out = await nativeSignWithGeneration(
			'envelope',
			() => {
				builds += 1
				return `text-${builds}`
			},
			s.deps,
		)
		expect(out).toEqual({ ok: true, signature: SIG })
		expect(s.sent).toHaveLength(2)
		expect(s.sent.map((c) => c.inboundGeneration)).toEqual([2, 2])
		expect(s.sent.map((c) => c.message)).toEqual(['text-1', 'text-2'])
		expect(builds).toBe(2)
		expect(s.waits).toEqual([35_000, 35_000])
	})

	it('only one resend: a second silence fails with timeout, and the page sends no third request', async () => {
		const s = script([TIMEOUT, TIMEOUT])
		await expect(nativeSignWithGeneration('group', () => 'g', s.deps)).resolves.toEqual({ ok: false, reason: 'timeout' })
		expect(s.sent).toHaveLength(2)
	})

	it('no answer and the generation has advanced: abandoned; nothing is re-signed or sent under the new generation', async () => {
		const s = script([
			(n) => {
				expect(n).toBe(1)
				s.setGeneration(3)
				return TIMEOUT
			},
			ACK_OK,
		])
		let builds = 0
		const out = await nativeSignWithGeneration(
			'envelope',
			() => {
				builds += 1
				return 'text'
			},
			s.deps,
		)
		expect(out).toEqual({ ok: false, reason: 'generation_expired' })
		expect(s.sent).toHaveLength(1)
		expect(s.sent[0].inboundGeneration).toBe(2)
		expect(builds).toBe(1)
	})

	it('a generation that advances during the resend wait also abandons the request', async () => {
		const s = script([
			TIMEOUT,
			(n) => {
				expect(n).toBe(2)
				s.setGeneration(3)
				return TIMEOUT
			},
		])
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'generation_expired' })
		expect(s.sent).toHaveLength(2)
	})

	it('an answer inside the 30 s wait is accepted; nothing is resent', async () => {
		const s = script([ACK_OK])
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: true, signature: SIG })
		expect(s.sent).toHaveLength(1)
	})

	it('a refusal from the native layer is not a drop: it is returned at once, with no resend', async () => {
		const s = script([{ kind: 'ack', ok: false, reason: 'locked' }])
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'locked' })
		expect(s.sent).toHaveLength(1)
	})
})

describe('the field has the wrong type ', () => {
	it('a string generation is bad_request; nothing is signed or sent', async () => {
		const s = script([ACK_OK])
		s.setGeneration('2')
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'bad_request' })
		expect(s.sent).toEqual([])
	})

	it('decimal, negative and over-range values are bad_request too', async () => {
		for (const bad of [2.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
			const s = script([ACK_OK])
			s.setGeneration(bad)
			await expect(nativeSignWithGeneration('group', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'bad_request' })
			expect(s.sent).toEqual([])
		}
	})

	it('the request carries the field at the top level, next to kind and message; no reqId is added here', async () => {
		const s = script([ACK_OK])
		await nativeSignWithGeneration('group', () => 'text', s.deps)
		expect(Object.keys(s.sent[0]).sort()).toEqual(['inboundGeneration', 'kind', 'message', 'type'])
		expect(s.sent[0]).toMatchObject({ type: 'gossipSign', kind: 'group', message: 'text', inboundGeneration: 2 })
	})

	it('an ack that is not a signature is bad_ack, and a selfAuth kind is not this path', async () => {
		const s = script([{ kind: 'ack', ok: true, result: { signature: '0x12' } }])
		await expect(nativeSignWithGeneration('envelope', () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'bad_ack' })
		await expect(nativeSignWithGeneration('selfAuth' as never, () => 'text', s.deps)).resolves.toEqual({ ok: false, reason: 'kind_not_allowed' })
	})
})
