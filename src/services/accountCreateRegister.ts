/**
 * New-account registration in a shell (interface text PROTOCOL-new-account-registration-v1, frozen 2026-11-23; QA builds only until accepted).
 *
 * The page collects the BeamioTag and the password and sends ONE command, `accountCreateRegister {type, reqId, tag, password}`. The native
 * layer creates and seals the account and answers an ack envelope (clarification 1): `{type:"ack", reqId, ok:true, result:{accountName, wallet,
 * signMessage, recover, recoverCodeBase58}}`, or `{type:"ack", reqId, ok:false, error}`. The page forwards
 * `{accountName, recover, wallet, signMessage}` unchanged to /api/addUser and shows the recover code. It never signs, never holds a key.
 *
 * Password: it lives only in this call's stack. It is never logged (the log names step and code only), never stored, never put in a state
 * kept after the call, never counted by the QA counter (which stores command names). The recover code is returned once and is never logged
 * or stored by the page.
 *
 * One in flight at a time. A retry of the forward reuses the SAME payload held in memory (a new command would make a new recover and overwrite
 * the one the user was shown). After a restart nothing is held: the command is called again, and `already_registered` ends it without addUser.
 */
import { ACCOUNT_CREATE_REGISTER_ENABLED } from '@/utils/accountCreateRegisterFlag'
import { nextReqId } from './nativeChatRouteRegister'
import { sendAccountCreateRegister } from './shellPageCreate'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export const ACCOUNT_CREATE_REGISTER_COMMAND = 'accountCreateRegister'
export { ACCOUNT_CREATE_REGISTER_ENABLED }

const WALLET_RE = /^0x[0-9a-f]{40}$/
const SIGN_RE = /^0x[0-9a-fA-F]{130}$/
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/
const SUCCESS_TOP_KEYS: ReadonlySet<string> = new Set(['type', 'ok', 'reqId', 'result'])
const RESULT_KEYS: ReadonlySet<string> = new Set(['accountName', 'wallet', 'signMessage', 'recover', 'recoverCodeBase58'])
const FAILURE_KEYS: ReadonlySet<string> = new Set(['type', 'ok', 'reqId', 'error'])
const RECOVER_ITEM_KEYS: ReadonlySet<string> = new Set(['hash', 'encrypto'])

export type RegisterErrorCode = 'bad_request' | 'bad_tag' | 'bad_password' | 'tag_taken' | 'sign_failed' | 'seal_failed' | 'not_ready' | 'in_flight' | 'not_available' | 'already_registered'
const ERROR_CODES: readonly string[] = ['bad_request', 'bad_tag', 'bad_password', 'tag_taken', 'sign_failed', 'seal_failed', 'not_ready', 'in_flight', 'not_available', 'already_registered']

/** What the forward sends: exactly these four fields as the native layer gave them. */
export type RegisterPayload = { accountName: string; recover: Array<{ hash: string; encrypto: string }>; wallet: string; signMessage: string }

export type RegisterReply =
	| { ok: true; payload: RegisterPayload; recoverCodeBase58: string }
	| { ok: false; code: RegisterErrorCode | 'failed' | 'bad_response' | 'unavailable' }

/** The command: exactly four keys. The password is the only secret and only goes in this command. */
export function buildAccountCreateRegisterCommand(reqId: number, tag: string, password: string): { type: string; reqId: number; tag: string; password: string } {
	return { type: ACCOUNT_CREATE_REGISTER_COMMAND, reqId, tag, password }
}

/** Reads one answer by the key whitelist. Any other key makes the whole answer `bad_response`. Nothing of it is logged. */
export function parseAccountCreateRegisterReply(payload: unknown, tag: string): RegisterReply {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'bad_response' }
	const p = payload as Record<string, unknown>
	if (p.ok === false) {
		for (const k of Object.keys(p)) if (!FAILURE_KEYS.has(k)) return { ok: false, code: 'bad_response' }
		const e = typeof p.error === 'string' ? p.error : ''
		return { ok: false, code: (ERROR_CODES.includes(e) ? e : 'failed') as RegisterErrorCode | 'failed' }
	}
	if (p.ok !== true) return { ok: false, code: 'bad_response' }
	for (const k of Object.keys(p)) if (!SUCCESS_TOP_KEYS.has(k)) return { ok: false, code: 'bad_response' }
	const res = p.result
	if (!res || typeof res !== 'object' || Array.isArray(res)) return { ok: false, code: 'bad_response' }
	const r = res as Record<string, unknown>
	for (const k of Object.keys(r)) if (!RESULT_KEYS.has(k)) return { ok: false, code: 'bad_response' }
	const accountName = r.accountName
	const wallet = r.wallet
	const signMessage = r.signMessage
	const recover = r.recover
	const code = r.recoverCodeBase58
	const want = tag.trim().replace(/^@+/, '')
	if (typeof accountName !== 'string' || accountName.replace(/^@+/, '').toLowerCase() !== want.toLowerCase()) return { ok: false, code: 'bad_response' }
	if (typeof wallet !== 'string' || !WALLET_RE.test(wallet)) return { ok: false, code: 'bad_response' }
	if (typeof signMessage !== 'string' || !SIGN_RE.test(signMessage)) return { ok: false, code: 'bad_response' }
	if (!Array.isArray(recover) || recover.length === 0) return { ok: false, code: 'bad_response' }
	for (const item of recover) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'bad_response' }
		const keys = Object.keys(item as Record<string, unknown>)
		if (keys.length !== RECOVER_ITEM_KEYS.size || keys.some((k) => !RECOVER_ITEM_KEYS.has(k))) return { ok: false, code: 'bad_response' }
		if (typeof (item as Record<string, unknown>).hash !== 'string' || typeof (item as Record<string, unknown>).encrypto !== 'string') return { ok: false, code: 'bad_response' }
	}
	if (typeof code !== 'string' || !BASE58_RE.test(code)) return { ok: false, code: 'bad_response' }
	return { ok: true, payload: { accountName, recover: recover as RegisterPayload['recover'], wallet, signMessage }, recoverCodeBase58: code }
}

export type ForwardResult = { kind: 'ok' } | { kind: 'http'; status: number } | { kind: 'network' }

export type RegisterDeps = {
	/** sends the command and answers the raw payload, or null on timeout or no channel */
	send: (cmd: { type: string; reqId: number; tag: string; password: string }) => Promise<unknown | null>
	forward: (body: RegisterPayload) => Promise<ForwardResult>
	/** the registry read: does it hold this tag for this EOA with its recover record */
	registryHas: (tag: string, eoa: string) => Promise<'yes' | 'no' | 'unknown'>
	/** the EOA of an existing native wallet, or '' when there is none */
	existingEoa: () => Promise<string>
	sleep: (ms: number) => Promise<void>
}

export type RegisterOutcome =
	| { ok: true; wallet: string; recoverCodeBase58: string | null; alreadyRegistered: boolean }
	| { ok: false; code: RegisterErrorCode | 'failed' | 'bad_response' | 'unavailable' | 'post_failed' | 'post_refused' | 'registry_unknown'; retryable: boolean }

const BACKOFF_MS = [2000, 4000, 8000]

let inFlight = false
/** The payload of this creation flow, held in memory only (never stored). A retry of the forward uses it as it is. */
let held: { tag: string; payload: RegisterPayload; recoverCodeBase58: string } | null = null

export function resetAccountCreateRegisterForTest(): void {
	inFlight = false
	held = null
}

const norm = (tag: string): string => tag.trim().replace(/^@+/, '').toLowerCase()

/** Forwards the held payload: 2xx done; 409 reads the registry; other 4xx stops; 5xx and network retry the same payload (2, 4, 8 s). */
async function forwardHeld(deps: RegisterDeps): Promise<RegisterOutcome | null> {
	const h = held
	if (!h) return { ok: false, code: 'failed', retryable: false }
	for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
		const r = await deps.forward(h.payload)
		if (r.kind === 'ok') {
			held = null
			return { ok: true, wallet: h.payload.wallet, recoverCodeBase58: h.recoverCodeBase58, alreadyRegistered: false }
		}
		if (r.kind === 'http' && r.status === 409) {
			const has = await deps.registryHas(h.tag, h.payload.wallet)
			if (has === 'yes') {
				held = null
				return { ok: true, wallet: h.payload.wallet, recoverCodeBase58: h.recoverCodeBase58, alreadyRegistered: true }
			}
			return { ok: false, code: has === 'unknown' ? 'registry_unknown' : 'post_refused', retryable: has === 'unknown' }
		}
		if (r.kind === 'http' && r.status >= 400 && r.status < 500) {
			publishNativePwaLog('warn', `[accountCreateRegister] forward refused status=${r.status}`)
			return { ok: false, code: 'post_refused', retryable: false }
		}
		if (attempt < BACKOFF_MS.length) await deps.sleep(BACKOFF_MS[attempt])
	}
	publishNativePwaLog('warn', '[accountCreateRegister] forward failed after the retries; the payload is kept for a manual retry')
	return { ok: false, code: 'post_failed', retryable: true }
}

/**
 * One creation flow. The password is a parameter of this call only. Returns an outcome; never throws; never logs the password or the payload.
 */
export async function registerNewAccount(input: { tag: string; password: string }, deps: RegisterDeps): Promise<RegisterOutcome> {
	if (!ACCOUNT_CREATE_REGISTER_ENABLED) return { ok: false, code: 'unavailable', retryable: false }
	if (inFlight) return { ok: false, code: 'in_flight', retryable: true }
	inFlight = true
	try {
		const tag = input.tag.trim().replace(/^@+/, '')
		// a payload held for another tag is not this flow's: dropped (nothing was registered with it)
		if (held && norm(held.tag) !== norm(tag)) held = null
		// a held payload: only the forward is retried, the command is not sent again
		if (held) return (await forwardHeld(deps)) ?? { ok: false, code: 'failed', retryable: false }
		for (let attempt = 0; attempt < 2; attempt++) {
			const reqId = nextReqId()
			publishNativePwaLog('info', `[accountCreateRegister] command sent tagLen=${tag.length} passwordLen=${input.password.length}`)
			const raw = await deps.send(buildAccountCreateRegisterCommand(reqId, tag, input.password))
			if (raw === null) return { ok: false, code: 'unavailable', retryable: true }
			const reply = parseAccountCreateRegisterReply(raw, tag)
			if (!reply.ok) {
				publishNativePwaLog('warn', `[accountCreateRegister] answer: ${reply.code}`)
				// the registry already holds this tag for this account: registered; addUser is NOT called (it would overwrite the recover record)
				if (reply.code === 'already_registered') {
					let eoa = ''
					try {
						eoa = await deps.existingEoa()
					} catch {
						eoa = ''
					}
					return eoa ? { ok: true, wallet: eoa, recoverCodeBase58: null, alreadyRegistered: true } : { ok: false, code: 'not_ready', retryable: true }
				}
				// sign_failed and seal_failed: one retry of the command (nothing was registered yet)
				if ((reply.code === 'sign_failed' || reply.code === 'seal_failed') && attempt === 0) continue
				const retryable = reply.code === 'sign_failed' || reply.code === 'seal_failed' || reply.code === 'not_ready' || reply.code === 'in_flight' || reply.code === 'failed'
				return { ok: false, code: reply.code, retryable }
			}
			held = { tag, payload: reply.payload, recoverCodeBase58: reply.recoverCodeBase58 }
			return (await forwardHeld(deps)) ?? { ok: false, code: 'failed', retryable: false }
		}
		return { ok: false, code: 'failed', retryable: true }
	} finally {
		inFlight = false
	}
}

/** The deps of the app: the shared request on the chat-module channel, the forward through beamio.ts, the registry read. */
export async function realRegisterDeps(): Promise<RegisterDeps> {
	const { postAddUserPayload, registryHasAccount } = await import('./beamio')
	const { readWalletEoaAddress } = await import('./walletEoaAddress')
	return {
		// 0.53.50: the trusted shell adapter (Android window.BeamioShell, iOS CashTreesIOS), not the chat-module channel
		send: async (cmd) => sendAccountCreateRegister({ reqId: cmd.reqId, tag: cmd.tag, password: cmd.password }),
		forward: async (body) => postAddUserPayload(body),
		registryHas: registryHasAccount,
		existingEoa: async () => {
			const r = await readWalletEoaAddress().catch(() => null)
			return r && r.kind === 'address' ? r.eoa : ''
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	}
}
