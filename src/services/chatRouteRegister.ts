/**
 * `POST /api/regiestChatRoute`. Two paths, decided by the shell state (`shellChatState`):
 *
 * - Browser (not a shell): the page signs the registration with the account key (EIP-191). This is the approved exception
 * Scope: the browser only, this one call.
 * - Shell: the native layer signs and returns the fields and the signature (`nativeChatRouteRegister`). The page checks the
 * result and posts it unchanged. A failure never falls back to the page key and never sends HTTP.
 *
 * Pure: the signers and the POST are passed in.
 */
import type { NativeRouteOutcome } from './nativeChatRouteRegister'

export type RouteRegisterFields = {
	wallet: string
	keyID: string
	publicKeyArmored: string
	encrypKeyArmored: string
	routeKeyID: string
	timestamp: number
	nonce: string
}

export type RouteRegisterOutcome = { ok: true } | { ok: false; reason: string }

/** The fields of a native `result`, in the order the server takes them. The page does not reorder them. */
export const NATIVE_RESULT_KEYS = [
	'wallet',
	'keyID',
	'publicKeyArmored',
	'encrypKeyArmored',
	'routeKeyID',
	'timestamp',
	'nonce',
	'signature',
] as const

/**
 * Browser path. The signature comes from the page signer; the server flag decides the outcome. Only the browser calls this.
 */
/**
 * The class of one HTTP answer of the registration POST (SDK-side rule, owner plan): 2xx is accepted; 4xx is refused and is never retried
 * automatically; 5xx is a server failure and is retried with the backoff; no answer is a network failure, also retried with the backoff.
 */
export type RegisterHttpClass = 'accepted' | 'refused' | 'server' | 'network'

export function classifyRegisterStatus(status: number | null): RegisterHttpClass {
	if (status === null) return 'network'
	if (status >= 200 && status < 300) return 'accepted'
	if (status >= 400 && status < 500) return 'refused'
	if (status >= 500 && status < 600) return 'server'
	return 'network'
}

export async function submitBrowserChatRouteRegister(
	fields: RouteRegisterFields,
	deps: {
		signInPage: (fields: RouteRegisterFields) => Promise<string>
		post: (body: Record<string, unknown>) => Promise<{ ok: boolean; status?: number | null }>
	},
): Promise<RouteRegisterOutcome> {
	const signature = await deps.signInPage(fields)
	const res = await deps.post({ ...fields, signature })
	if (res.ok) return { ok: true }
	// no status reported (an older caller): the same reason as before
	if (res.status === undefined) return { ok: false, reason: 'server_rejected' }
	const cls = classifyRegisterStatus(res.status)
	if (cls === 'refused') return { ok: false, reason: 'refused_4xx' }
	if (cls === 'server') return { ok: false, reason: 'server_5xx' }
	if (cls === 'network') return { ok: false, reason: 'network' }
	return { ok: false, reason: 'server_rejected' }
}

/**
 * Checks a native `result` before it is posted: exactly the eight fields, in the spec order, with the types the server takes.
 * Anything else (a key, a backup password, a recovery code, an extra field) is `bad_ack`, and nothing is posted.
 */
export function judgeNativeRegisterResult(result: Record<string, unknown>): 'ok' | 'bad_ack' | 'submitted' {
	const keys = Object.keys(result)
	//the native layer registered the route itself. Its result is only {code:"submitted"}; the page posts nothing.
	if (keys.length === 1 && keys[0] === 'code' && result.code === 'submitted') return 'submitted'
	if (keys.length !== NATIVE_RESULT_KEYS.length) return 'bad_ack'
	for (let i = 0; i < keys.length; i++) if (keys[i] !== NATIVE_RESULT_KEYS[i]) return 'bad_ack'
	for (const k of ['wallet', 'keyID', 'publicKeyArmored', 'encrypKeyArmored', 'routeKeyID', 'nonce', 'signature'] as const) {
		if (typeof result[k] !== 'string' || (result[k] as string).length === 0) return 'bad_ack'
	}
	if (typeof result.timestamp !== 'number' || !Number.isInteger(result.timestamp)) return 'bad_ack'
	return 'ok'
}

/**
 * Shell path. A failed native outcome ends the registration with its code and posts nothing. A successful outcome is checked
 * and posted unchanged.
 */
export async function submitNativeChatRouteRegister(
	outcome: NativeRouteOutcome,
	post: (body: Record<string, unknown>) => Promise<{ ok: boolean }>,
): Promise<RouteRegisterOutcome> {
	if (!outcome.ok) return { ok: false, reason: `native_${outcome.code}` }
	if ('submitted' in outcome) return { ok: true }
	const judged = judgeNativeRegisterResult(outcome.result)
	if (judged === 'submitted') return { ok: true }
	if (judged !== 'ok') return { ok: false, reason: 'native_bad_ack' }
	const body: Record<string, unknown> = {}
	for (const k of NATIVE_RESULT_KEYS) body[k] = outcome.result[k]
	const res = await post(body)
	return res.ok ? { ok: true } : { ok: false, reason: 'server_rejected' }
}

/**
 * The backup password rule (a decision vector). The native layer forms the backup with the EOA key string
 * in its own memory. The page never forms or sends a password, so this rule is kept here only so that the conformance
 * vectors are checked against one definition.
 */
export function isCanonicalEoaPasswordFormat(password: string): boolean {
	return /^0x[0-9a-f]{64}$/.test(password)
}
