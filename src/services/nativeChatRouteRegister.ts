/**
 * Native chat route registration (spec, W5 kind `chatRouteRegister`, 2026-11-13).
 *
 * The page asks the native wallet layer with `{type: "chatRouteRegister", reqId, keyID, publicKeyArmored, routeKeyID}`.
 * The native layer builds the wallet, the backup, the timestamp, the nonce, the message and the EIP-191 signature, and
 * answers with `{type: "ack", reqId, ok: true, result: {...}}`, or `{type: "ack", reqId, ok: false, error}`.
 *
 * The page sends exactly those four fields. It holds no key here: the request is built from public fields only, and no
 * page signature is made on this path. Any failure ends the registration with a code; nothing falls back.
 */
import { NATIVE_KEYS_CAPABILITY, ROUTE_REGISTER_CAPABILITY } from './shellChatState'
import { eventPayloadOf, NATIVE_EVENT_NAMES, postChatModuleCommand } from './nativeKeyState'

export const CHAT_ROUTE_REGISTER_COMMAND = 'chatRouteRegister'
/** Same protocol version the chat transports send in `hello`. */
const HELLO_PROTOCOL_VERSION = 1
const HELLO_TIMEOUT_MS = 5_000
const REGISTER_TIMEOUT_MS = 20_000
/** Own reqId range: never matches a chat transport request, an import request or a wallet request. */
const REQ_BASE = 700_000_000
const MAX_SAFE = Number.MAX_SAFE_INTEGER

let seq = 0

/** Codes the spec defines for a failed registration. */
export const NATIVE_ROUTE_ERROR_CODES = [
	'no_key',
	'not_ready',
	'locked',
	'native_unavailable',
	'bad_request',
	'no_pgp_key',
	'sig_rejected',
] as const
export type NativeRouteErrorCode = (typeof NATIVE_ROUTE_ERROR_CODES)[number]

/** Page-side failures that are not in the spec table: timeout, no channel, and an ack that breaks the envelope rule. */
export type NativeRouteLocalCode = 'timeout' | 'bad_ack'

export type NativeRouteOutcome =
	| { ok: true; result: Record<string, unknown> }
	| { ok: false; code: NativeRouteErrorCode | NativeRouteLocalCode }

export type NativeRouteInput = {
	keyID: string
	publicKeyArmored: string
	routeKeyID: string
}

type Loose = Record<string, unknown>

/** reqId rule (decision vectors group B): a string of 1–64 ASCII bytes 0x20–0x7E, not trimmed, or an integer 0 to 2^53−1. */
export function isValidReqId(value: unknown): boolean {
	if (typeof value === 'string') return /^[\x20-\x7e]{1,64}$/.test(value)
	if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= MAX_SAFE
	return false
}

const isPlainObject = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Input rule before anything is sent: the three fields are present, the key id and route id carry no CR or LF, and the
 * public key is base64 text. Returns `bad_request` without touching the bridge when a check fails.
 */
export function precheckRouteInput(input: NativeRouteInput): NativeRouteErrorCode | null {
	const rawKeyID = typeof input.keyID === 'string' ? input.keyID : ''
	const rawRouteKeyID = typeof input.routeKeyID === 'string' ? input.routeKeyID : ''
	// CR or LF is checked before trimming: a trailing CR is a shape error, not whitespace.
	if (/[\r\n]/.test(rawKeyID) || /[\r\n]/.test(rawRouteKeyID)) return 'bad_request'
	const keyID = rawKeyID.trim()
	const routeKeyID = rawRouteKeyID.trim()
	const publicKeyArmored = typeof input.publicKeyArmored === 'string' ? input.publicKeyArmored.trim() : ''
	if (!keyID || !routeKeyID || !publicKeyArmored) return 'bad_request'
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyArmored)) return 'bad_request'
	return null
}

/** One request on the chat-module channel. Resolves with the ack or ready payload for its reqId. */
function request(
	cmd: Loose,
	timeoutMs: number,
): Promise<{ kind: 'payload'; payload: Loose } | { kind: 'timeout' } | { kind: 'unavailable' }> {
	if (typeof window === 'undefined') return Promise.resolve({ kind: 'unavailable' })
	const reqId = cmd.reqId as number
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const done = (answer: { kind: 'payload'; payload: Loose } | { kind: 'timeout' } | { kind: 'unavailable' }) => {
			for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
			if (timer !== undefined) clearTimeout(timer)
			resolve(answer)
		}
		const listener = (ev: Event) => {
			const payload = eventPayloadOf(ev)
			if (!payload || payload.reqId !== reqId) return
			if (payload.type === 'ack' || payload.type === 'ready') done({ kind: 'payload', payload })
		}
		for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
		timer = setTimeout(() => done({ kind: 'timeout' }), timeoutMs)
		let sent = false
		try {
			sent = postChatModuleCommand(cmd)
		} catch {
			sent = false
		}
		if (!sent) done({ kind: 'unavailable' })
	})
}

export function nextReqId(): number {
	seq += 1
	return REQ_BASE + seq
}

/**
 * The shell's `hello` answer. `answered` is false when there is no channel or no answer (a shell before the capability).
 */
export async function probeNativeCapabilities(
	timeoutMs: number = HELLO_TIMEOUT_MS,
): Promise<{ answered: boolean; capabilities: string[] }> {
	const answer = await request({ type: 'hello', reqId: nextReqId(), protocolVersion: HELLO_PROTOCOL_VERSION }, timeoutMs)
	if (answer.kind !== 'payload') return { answered: false, capabilities: [] }
	const p = answer.payload
	const ok = p.type === 'ready' || (p.type === 'ack' && p.ok === true)
	const result = (p.type === 'ready' ? p.result : p.result ?? p) as Loose | undefined
	const caps = isPlainObject(result) && Array.isArray(result.capabilities) ? result.capabilities : []
	return { answered: ok, capabilities: caps.filter((c): c is string => typeof c === 'string') }
}

/**
 * Judges one ack against the envelope rule (decision vectors group A). Returns the result on success and a code on
 * failure; anything that breaks the envelope is `bad_ack`.
 */
export function judgeRouteAck(payload: Loose): NativeRouteOutcome {
	if (payload.type !== 'ack') return { ok: false, code: 'bad_ack' }
	if (payload.ok === true) {
		if ('code' in payload || 'error' in payload) return { ok: false, code: 'bad_ack' }
		if (!isPlainObject(payload.result)) return { ok: false, code: 'bad_ack' }
		return { ok: true, result: payload.result }
	}
	if (payload.ok === false) {
		if ('result' in payload || 'code' in payload) return { ok: false, code: 'bad_ack' }
		const error = payload.error
		if (typeof error === 'string' && (NATIVE_ROUTE_ERROR_CODES as readonly string[]).includes(error)) {
			return { ok: false, code: error as NativeRouteErrorCode }
		}
		return { ok: false, code: 'bad_ack' }
	}
	return { ok: false, code: 'bad_ack' }
}

/**
 * Asks the native layer to register the chat route. Sends the four fields only. Any failure returns a code and the caller
 * must not send the HTTP request. Nothing here signs in the page.
 */
export async function nativeChatRouteRegister(
	input: NativeRouteInput,
	opts: { timeoutMs?: number; helloTimeoutMs?: number } = {},
): Promise<NativeRouteOutcome> {
	const pre = precheckRouteInput(input)
	if (pre) return { ok: false, code: pre }
	const probe = await probeNativeCapabilities(opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
	// Option A: without identity.native-keys.v1 nothing identity-bearing is sent, registration included.
	if (!probe.answered || !probe.capabilities.includes(NATIVE_KEYS_CAPABILITY) || !probe.capabilities.includes(ROUTE_REGISTER_CAPABILITY)) {
		return { ok: false, code: 'native_unavailable' }
	}
	const reqId = nextReqId()
	// Exactly these four fields. No wallet, message, signature, timestamp, nonce, backup or private key.
	const cmd: Loose = {
		type: CHAT_ROUTE_REGISTER_COMMAND,
		reqId,
		keyID: input.keyID.trim(),
		publicKeyArmored: input.publicKeyArmored.trim(),
		routeKeyID: input.routeKeyID.trim(),
	}
	const answer = await request(cmd, opts.timeoutMs ?? REGISTER_TIMEOUT_MS)
	if (answer.kind === 'timeout') return { ok: false, code: 'timeout' }
	if (answer.kind === 'unavailable') return { ok: false, code: 'native_unavailable' }
	if (answer.payload.reqId !== reqId) return { ok: false, code: 'bad_ack' }
	return judgeRouteAck(answer.payload)
}

/** The shared request on the chat-module channel, with a fresh reqId (used by the PGP restore action as well). */
export function requestNativeAck(cmd: Loose, timeoutMs: number, reqId?: number) {
	return request({ ...cmd, reqId: reqId ?? nextReqId() }, timeoutMs)
}
