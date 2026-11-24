/**
 * Native chat route registration (kind `chatRouteRegister`).
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
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export const CHAT_ROUTE_REGISTER_COMMAND = 'chatRouteRegister'
/** Same protocol version the chat transports send in `hello`. */
const HELLO_PROTOCOL_VERSION = 1
/**
 * hello, the page's one shared probe (hello single flight, late is not dead).
 * - The one timeout the callers see (HELLO_TIMEOUT_MS, 10 s: the old 5 s and 10 s are one value now) only CLASSIFIES: a caller that gets no answer in that time is told
 *   `answered: false` ("not answered yet"), and nothing is cancelled or sent again because of it.
 * - The request itself waits HELLO_WINDOW_MS (180 s, the cold-start window). A valid answer at any time before that is taken, kept for the
 *   page load (the capability list of one shell is static), and announced to onHelloValid listeners (late answers included).
 * - One hello in flight; at most ONE more is sent, no earlier than HELLO_RESEND_AFTER_MS after the first, while no valid answer is there;
 *   never more than two in flight.
 * - No answer is not a missing capability: only a valid answer without the capability is "missing".
 */
const HELLO_TIMEOUT_MS = 10_000
export const HELLO_WINDOW_MS = 180_000
export const HELLO_RESEND_AFTER_MS = 60_000
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
	//fail closed. network_unavailable and chain_refused may be retried; key_mismatch goes to the recovery prompt.
	'backup_failed',
	'backup_readback_failed',
	'key_mismatch',
	'sign_failed',
	'chain_refused',
	'network_unavailable',
	//the native side got a success answer but the chain does not show the registration. Not a success on the page:
	// it is an unfinished, retryable state and nothing is posted.
	'unverified_submit',
] as const
export type NativeRouteErrorCode = (typeof NATIVE_ROUTE_ERROR_CODES)[number]

/** Page-side failures that are not in the spec table: timeout, no channel, and an ack that breaks the envelope rule. */
export type NativeRouteLocalCode = 'timeout' | 'bad_ack'

export type NativeRouteOutcome =
	| { ok: true; result: Record<string, unknown> }
	/**: the native layer registered the route itself; the page posts nothing. */
	| { ok: true; submitted: true }
	| { ok: false; code: NativeRouteErrorCode | NativeRouteLocalCode }

export type NativeRouteInput = {
	keyID: string
	publicKeyArmored: string
	routeKeyID: string
}

type Loose = Record<string, unknown>

/** reqId rule (decision vector): a string of 1–64 ASCII bytes 0x20–0x7E, not trimmed, or an integer 0 to 2^53−1. */
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
/** reqIds whose answer was taken (decided). A later reply with one of them is dropped and logged ( ②). Bounded. */
const concludedReqIds: number[] = []
/** reqIds with a request still open (waiting for their answer). */
const openReqIds = new Set<number>()
let concludedWatchInstalled = false
function ensureConcludedWatch(): void {
	if (concludedWatchInstalled || typeof window === 'undefined') return
	concludedWatchInstalled = true
	// an ack for a request that is not open is dropped, with a log ( ②): cause=decided when its answer was taken, otherwise reqid_mismatch
	const watch = (ev: Event) => {
		const payload = eventPayloadOf(ev)
		if (!payload || payload.type !== 'ack' || typeof payload.reqId !== 'number') return
		if (openReqIds.has(payload.reqId)) return
		const cause = concludedReqIds.includes(payload.reqId) ? 'decided' : 'reqid_mismatch'
		publishNativePwaLog('warn', `[start] late_result_discarded reqId=${payload.reqId} cause=${cause}`)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, watch)
}
function markConcluded(reqId: number): void {
	concludedReqIds.push(reqId)
	if (concludedReqIds.length > 64) concludedReqIds.shift()
}

function request(
	cmd: Loose,
	timeoutMs: number,
): Promise<{ kind: 'payload'; payload: Loose } | { kind: 'timeout' } | { kind: 'unavailable' }> {
	if (typeof window === 'undefined') return Promise.resolve({ kind: 'unavailable' })
	const reqId = cmd.reqId as number
	ensureConcludedWatch()
	openReqIds.add(reqId)
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const done = (answer: { kind: 'payload'; payload: Loose } | { kind: 'timeout' } | { kind: 'unavailable' }) => {
			for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
			if (timer !== undefined) clearTimeout(timer)
			openReqIds.delete(reqId)
			if (answer.kind === 'payload') markConcluded(reqId)
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
/** `raw` is the hello ack's result as the shell sent it (the chat transport reads its protocol fields from it). */
export type HelloResult = { answered: boolean; capabilities: string[]; nativeApp?: unknown; raw?: unknown }

type HelloShared = {
	bridge: unknown[]
	valid: HelloResult | null
	inFlight: number
	startedAt: number
	resentAt: number
	resendTimer: ReturnType<typeof setTimeout> | undefined
	waiters: Array<(r: HelloResult) => void>
}
let shared: HelloShared | null = null
const helloListeners = new Set<(r: HelloResult) => void>()

/** The shell objects the page talks to. A different set (a new page, a test double) is a different shell: the shared state starts over. */
const bridgeIdentity = (): unknown[] => {
	if (typeof window === 'undefined') return []
	const w = window as unknown as Record<string, unknown>
	return [w.CashTreesIOS, w.CashTreesAndroid, w.BeamioChat, w.BeamioShell]
}
const sameBridge = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** The valid hello answer kept for this page load (the capability list is static), or null. */
export function getCachedHello(): HelloResult | null {
	return shared && sameBridge(shared.bridge, bridgeIdentity()) ? shared.valid : null
}
/** The raw hello result of the kept valid answer, or undefined. The chat transport uses it instead of asking again. */
export function getCachedHelloRaw(): unknown {
	return getCachedHello()?.raw
}
/** True while no valid answer is there and the 180 s window (from the first hello of the cycle) has not run out. */
export function helloWithinWindow(now: number = Date.now()): boolean {
	if (!shared || !sameBridge(shared.bridge, bridgeIdentity())) return true
	if (shared.valid) return false
	return now - shared.startedAt < HELLO_WINDOW_MS
}
/** Listens to every valid hello answer (late ones too). */
export function onHelloValid(cb: (r: HelloResult) => void): () => void {
	helloListeners.add(cb)
	return () => {
		helloListeners.delete(cb)
	}
}
export function resetSharedHelloForTest(): void {
	if (shared?.resendTimer !== undefined) clearTimeout(shared.resendTimer)
	shared = null
	helloListeners.clear()
}

function judgeHello(p: Loose): HelloResult {
	const ok = p.type === 'ack' && p.ok === true
	const result = p.result as Loose | undefined
	const caps = isPlainObject(result) && Array.isArray(result.capabilities) ? result.capabilities : []
	const nativeApp = ok && isPlainObject(result) ? result.nativeApp : undefined
	return { answered: ok, capabilities: ok ? caps.filter((c): c is string => typeof c === 'string') : [], nativeApp, raw: ok ? result : undefined }
}

function sendOneHello(s: HelloShared): void {
	s.inFlight += 1
	// a request waits for what is left of the window, so no hello outlives it
	const left = Math.max(1_000, HELLO_WINDOW_MS - (Date.now() - s.startedAt))
	void request({ type: 'hello', reqId: nextReqId(), protocolVersion: HELLO_PROTOCOL_VERSION }, left).then((answer) => {
		s.inFlight -= 1
		if (shared !== s) return
		// no channel or no answer inside the window: nothing is learned (and nothing is declared missing); the callers still waiting hear
		// "not answered"
		if (answer.kind !== 'payload') {
			for (const w of s.waiters.splice(0)) w({ answered: false, capabilities: [] })
			return
		}
		const r = judgeHello(answer.payload)
		// a refusal is not a valid answer
		if (!r.answered) {
			for (const w of s.waiters.splice(0)) w(r)
			return
		}
		const first = s.valid === null
		s.valid = r
		if (s.resendTimer !== undefined) {
			clearTimeout(s.resendTimer)
			s.resendTimer = undefined
		}
		const waiters = s.waiters.splice(0)
		for (const w of waiters) w(r)
		if (first) for (const cb of [...helloListeners]) cb(r)
	})
}

function ensureSharedHello(): HelloShared {
	const now = Date.now()
	const bridge = bridgeIdentity()
	if (!shared || !sameBridge(shared.bridge, bridge)) {
		if (shared?.resendTimer !== undefined) clearTimeout(shared.resendTimer)
		shared = { bridge, valid: null, inFlight: 0, startedAt: now, resentAt: 0, resendTimer: undefined, waiters: [] }
	}
	const s = shared
	if (s.valid) return s
	// the window ran out with nothing in flight: a new cycle may begin (first hello again)
	if (s.inFlight === 0) {
		s.startedAt = now
		s.resentAt = 0
		sendOneHello(s)
	}
	// one more hello, once, no earlier than 60 s after the first, while there is still no valid answer; never more than two in flight
	if (s.resendTimer === undefined && s.resentAt === 0) {
		s.resendTimer = setTimeout(() => {
			s.resendTimer = undefined
			if (shared !== s || s.valid || s.inFlight >= 2 || s.resentAt !== 0) return
			s.resentAt = Date.now()
			sendOneHello(s)
		}, HELLO_RESEND_AFTER_MS)
	}
	return s
}

export async function probeNativeCapabilities(timeoutMs: number = HELLO_TIMEOUT_MS): Promise<HelloResult> {
	if (typeof window === 'undefined') return { answered: false, capabilities: [] }
	const cached = getCachedHello()
	if (cached) return cached
	const s = ensureSharedHello()
	if (s.valid) return s.valid
	// wait for a valid answer or for the classification time; the request itself keeps going either way
	return new Promise<HelloResult>((resolve) => {
		let done = false
		const finish = (r: HelloResult) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve(r)
		}
		const timer = setTimeout(() => finish({ answered: false, capabilities: [] }), timeoutMs)
		s.waiters.push(finish)
	})
}


/**
 * Judges one ack against the envelope rule (decision vector). Returns the result on success and a code on
 * failure; anything that breaks the envelope is `bad_ack`.
 */
export function judgeRouteAck(payload: Loose): NativeRouteOutcome {
	if (payload.type !== 'ack') return { ok: false, code: 'bad_ack' }
	if (payload.ok === true) {
		if ('code' in payload || 'error' in payload) return { ok: false, code: 'bad_ack' }
		if (!isPlainObject(payload.result)) return { ok: false, code: 'bad_ack' }
		// submitted: exactly {code:"submitted"} and no other field.
		const r = payload.result as Record<string, unknown>
		if (Object.keys(r).length === 1 && r.code === 'submitted') return { ok: true, submitted: true }
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
