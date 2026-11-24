/**
 * One request that carries the inbound generation to the native layer.
 *
 * A shell that declares `inbound.generation.v1` in its hello answer gets the field: the generation the page held when the request
 * started, at the top level of the command. Rules:
 * - Declared, nothing announced yet: `native_unavailable`, nothing sent.
 * - Declared, a value that is not a non-negative safe integer: `bad_request`, nothing sent.
 * - Declared, no answer within the wait (35 s): the request was dropped. An advanced generation means give up
 *   (`generation_expired`); the request is never re-sent under a new identity. An unchanged generation means resend once, with the
 *   same content (the same sendId, which the native layer uses to de-duplicate; the signature is made again by the native layer).
 * - Not declared (an older shell): no field, one attempt, the wait the older shell was given.
 * - An ack with `ok: false` is an answer, not a drop: it is returned at once, with no resend. This includes `send_timeout`, which the
 * native layer sends exactly once for an in-flight request whose generation is still valid. Whether the caller retries is
 * the caller's decision.
 *
 * Pure: the send, the generation and the declaration are injected. The chat transport and the signing path use it.
 */
import { isInboundGeneration } from './inboundGeneration'

/** The page's wait per attempt (35 seconds, longer than the native in-flight limit of 30 seconds). */
export const GENERATION_WAIT_MS = 35_000

/** The answer of one attempt. `timeout`: no answer within the wait (a dropped request). */
export type GenerationAttemptAnswer =
	| { kind: 'ack'; ok: true; result: unknown }
	| { kind: 'ack'; ok: false; reason: string }
	| { kind: 'timeout' }
	| { kind: 'unavailable' }

export type GenerationOutcome = { ok: true; result: unknown } | { ok: false; reason: string }

export type GenerationRequestDeps = {
	/** The page's latest generation, of any type, so a wrong value is refused rather than sent. */
	generation: () => unknown
	/** Sends one command and resolves with its answer, or `timeout` once `timeoutMs` has passed. */
	send: (cmd: Record<string, unknown>, timeoutMs: number) => Promise<GenerationAttemptAnswer>
	/** Wait per attempt for a declared shell; default `GENERATION_WAIT_MS`. */
	timeoutMs?: number
	/** True when the native layer declared `inbound.generation.v1`. Default: true. False: an older shell, no field, one attempt. */
	declared?: () => Promise<boolean>
	/** The single wait of an older shell; default `GENERATION_WAIT_MS`. */
	legacyTimeoutMs?: number
	/** Waits for the generation event (ms); injectable for tests. Default: a timer. */
	sleep?: (ms: number) => Promise<void>
	/** Step of the wait for the first generation event; default 200 ms. */
	pollMs?: number
}

/** Thrown by `build` to refuse the command before anything is sent (for example a message that is too long). */
export class GenerationRefusal extends Error {
	constructor(readonly reason: string) {
		super(reason)
	}
}

/** The command with `inboundGeneration` at the top level when a value is given; without it for an older shell. */
export function withInboundGeneration(cmd: Record<string, unknown>, generation: number | undefined): Record<string, unknown> {
	return generation === undefined ? cmd : { ...cmd, inboundGeneration: generation }
}

const finish = (answer: GenerationAttemptAnswer): GenerationOutcome => {
	if (answer.kind === 'ack') return answer.ok ? { ok: true, result: answer.result } : { ok: false, reason: answer.reason }
	if (answer.kind === 'unavailable') return { ok: false, reason: 'native_unavailable' }
	return { ok: false, reason: 'timeout' }
}

/**
 * Runs the request. `build(generation)` returns the whole command; `generation` is `undefined` for an older shell. The builder is called
 * again for a resend, so a resend is built from the same content.
 */
export async function requestWithInboundGeneration(
	build: (generation: number | undefined) => Record<string, unknown>,
	deps: GenerationRequestDeps,
): Promise<GenerationOutcome> {
	const isDeclared = deps.declared ? await deps.declared() : true
	/** One attempt. A refusal of `build` is returned as an answer that was never sent: it is not a drop, so it is not resent. */
	const attempt = async (generation: number | undefined, timeoutMs: number): Promise<GenerationAttemptAnswer> => {
		let cmd: Record<string, unknown>
		try {
			cmd = build(generation)
		} catch (e) {
			if (e instanceof GenerationRefusal) return { kind: 'ack', ok: false, reason: e.reason }
			throw e
		}
		return deps.send(cmd, timeoutMs)
	}
	if (!isDeclared) {
		const only = await attempt(undefined, deps.legacyTimeoutMs ?? GENERATION_WAIT_MS)
		return finish(only)
	}
	// Declared and no generation event yet: wait for it (a command without the field is never sent, and the wait is not a failure). Only after the
	// whole wait with no event is the answer native_unavailable.
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const pollMs = deps.pollMs ?? 200
	const limitMs = deps.timeoutMs ?? GENERATION_WAIT_MS
	for (let waited = 0; (deps.generation() === null || deps.generation() === undefined) && waited < limitMs; waited += pollMs) await sleep(pollMs)
	const at = deps.generation()
	if (at === null || at === undefined) return { ok: false, reason: 'native_unavailable' }
	if (!isInboundGeneration(at)) return { ok: false, reason: 'bad_request' }
	const timeoutMs = deps.timeoutMs ?? GENERATION_WAIT_MS
	const first = await attempt(at, timeoutMs)
	if (first.kind !== 'timeout') return finish(first)
	if (deps.generation() !== at) return { ok: false, reason: 'generation_expired' }
	const second = await attempt(at, timeoutMs)
	if (second.kind !== 'timeout') return finish(second)
	return { ok: false, reason: deps.generation() !== at ? 'generation_expired' : 'timeout' }
}
