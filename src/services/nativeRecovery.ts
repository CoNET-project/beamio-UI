/**
 * Recovery in a native shell. The recovery code, the PIN or password, the mnemonic and the derived keys
 * stay in the native layer. The page only opens the native recovery page (`nativeRecoveryOpen`: type and reqId, no data) and
 * receives short result codes (`nativeRecoveryResult`). Only `ok` carries the public address; only `backoff` carries a cooldown.
 *
 * Listening: a non-ok result keeps the page open, so the listener stays. `ok` ends the listening. A page that
 * stays open for 10 minutes without any result is treated as `cancelled` once it is visible again (the system may have reclaimed it).
 */
import { ethers } from 'ethers'
import { eventPayloadOf, NATIVE_EVENT_NAMES, withoutGlobalNoKeyLock } from './nativeKeyState'
import { nextReqId, probeNativeCapabilities, requestNativeAck } from './nativeChatRouteRegister'
import { sendShellWalletSyncCommand, shellRecordTransportKind } from './shellRecordTransport'
import { getCashTreesNativeNfcHost } from '@/utils/cashTreesNativeNfc'
import { parsePasscodeStatus, type NativeWalletState as NativeWalletStateReport } from './accountJudgement'
import { parseWalletStatusResult } from './accountPresence'
import { isMnemonicPhrase } from './walletCredential'
import { nextShellTxSeq } from './shellTxSeq'
import { diagnosticCode } from './diagnosticCodes'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

export const NATIVE_RECOVERY_OPEN_COMMAND = 'nativeRecoveryOpen'
export const NATIVE_RECOVERY_RESULT_EVENT = 'nativeRecoveryResult'
const OPEN_TIMEOUT_MS = 10_000
/**no result in this time, and visible again, means a local `cancelled`. */
export const NATIVE_RECOVERY_LOCAL_CANCEL_MS = 10 * 60 * 1000

export const NATIVE_RECOVERY_RESULT_CODES = [
	'ok',
	'cancelled',
	'invalid_format',
	'bad_pin',
	'backoff',
	'not_found',
	'network_error',
	'already_exists',
	'record_invalid',
	'write_failed',
	'readback_failed',
	'legacy_record',
	// (Android import/restore): unregister_refused, clear_failed, busy, main_thread. Any other code is `unknown`(generic retry copy).
	'unregister_refused',
	'clear_failed',
	'busy',
	'main_thread',
	'not_ready',
	'invalid_key',
	'invalid_mnemonic',
	'address_mismatch',
	'unknown',
] as const

export type NativeRecoveryResultCode = (typeof NATIVE_RECOVERY_RESULT_CODES)[number]

/**
 * the copy key the PWA shows for a native result code. `null`: the native page shows its own copy (existing codes).
 * `unknown` and the import-incomplete codes share the generic "import did not complete, try again" copy.
 */
export const nativeRecoveryCopyKey = (code: string): string | null => {
	if (code === 'legacy_record') return 'recovery.native.legacy_record'
	// the wallet is not ready yet (the native store or the wallet state is not ready). Placeholder copy until the formal copy flow.
	if (code === 'not_ready') return 'recovery.native.not_ready'
	if (code === 'unregister_refused') return 'import.unregister_refused'
	if (code === 'busy') return 'recovery.native.busy'
	if (code === 'clear_failed' || code === 'main_thread' || code === 'unknown') return 'recovery.native.import_incomplete'
	return null
}

export type NativeRecoveryResult = {
	code: NativeRecoveryResultCode
	/** Public address (lower case), only with `ok`. */
	eoa?: string
	/** Seconds to wait, only with `backoff`. */
	cooldownSec?: number
}

/**
 * Locale key for a failed open. `not_supported` and `not_available` have their own lines; any other
 * reason (bad_request, key_over_bridge_refused, a timeout) uses the generic restore failure. A failed open is never a success.
 */
export function recoveryOpenErrorKey(reason: string): string {
	if (reason === 'not_supported') return 'recovery.native.not_supported'
	if (reason === 'not_available') return 'recovery.native.not_available'
	return 'something_went_wrong_while_restoring_your_wallet'
}

type Subscriber = (result: NativeRecoveryResult) => void

const subscribers: Subscriber[] = []
let listening = false

/** The open page's watch: set when the shell acknowledges the open with ok, cleared when the page is done. */
type Watch = {
	timer: ReturnType<typeof setTimeout> | undefined
	resultSeen: boolean
	expired: boolean
	onVisible: () => void
}
let watch: Watch | null = null

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'

function endWatch(): void {
	if (!watch) return
	if (watch.timer !== undefined) clearTimeout(watch.timer)
	if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', watch.onVisible)
	watch = null
}

function beginWatch(): void {
	endWatch()
	const w: Watch = {
		timer: undefined,
		resultSeen: false,
		expired: false,
		onVisible: () => {
			// Visible again after the window has passed with no result: the page is gone, so the outcome is cancelled.
			if (watch !== w || !w.expired || w.resultSeen || !isVisible()) return
			emit({ code: 'cancelled' })
		},
	}
	w.timer = setTimeout(() => {
		w.timer = undefined
		if (watch !== w || w.resultSeen) return
		w.expired = true
		w.onVisible()
	}, NATIVE_RECOVERY_LOCAL_CANCEL_MS)
	if (typeof document !== 'undefined') document.addEventListener('visibilitychange', w.onVisible)
	watch = w
}

/** Delivers one result. `ok` removes each listener (the page is done); `ok` and `cancelled` end the watch. */
function emit(result: NativeRecoveryResult): void {
	for (const sub of subscribers.slice()) {
		sub(result)
		if (result.code === 'ok') {
			const at = subscribers.indexOf(sub)
			if (at >= 0) subscribers.splice(at, 1)
		}
	}
	if (result.code === 'ok' || result.code === 'cancelled') endWatch()
}

function onWindowEvent(ev: Event): void {
	const p = eventPayloadOf(ev)
	if (!p || p.type !== NATIVE_RECOVERY_RESULT_EVENT) return
	const code = p.code
	if (typeof code !== 'string') return
	// B7: a result with a reqId that is not the open request's is discarded (fail closed).
	// A result with no reqId is delivered with a warning during the QA candidate period only; the freeze drops it too.
	if (typeof p.reqId === 'number') {
		if (openedRecoveryReqId === null || p.reqId !== openedRecoveryReqId) {
			publishNativePwaLog('warn', '[nativeRecovery] nativeRecoveryResult reqId does not match the open request: discarded (B7)')
			return
		}
	} else {
		publishNativePwaLog('warn', '[nativeRecovery] nativeRecoveryResult has no reqId: delivered in the QA candidate period only (B7)')
	}
	// an unrecognised code is passed on as `unknown`(generic retry copy), not dropped.
	const known = (NATIVE_RECOVERY_RESULT_CODES as readonly string[]).includes(code)
	if (watch) watch.resultSeen = true
	const result: NativeRecoveryResult = { code: (known ? code : 'unknown') as NativeRecoveryResultCode }
	if (result.code === 'ok' && typeof p.eoa === 'string') result.eoa = p.eoa
	if (result.code === 'backoff' && typeof p.cooldownSec === 'number') result.cooldownSec = p.cooldownSec
	emit(result)
}

function startListening(): void {
	if (listening || typeof window === 'undefined') return
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, onWindowEvent)
	listening = true
}

function stopListeningIfIdle(): void {
	if (!listening || subscribers.length > 0 || typeof window === 'undefined') return
	for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, onWindowEvent)
	listening = false
}

/**
 * Asks the shell to open its recovery page. Resolves ok when the shell acknowledges (the page is open); the outcome comes as
 * `nativeRecoveryResult`. Nothing is a success until that event arrives.
 */
/**
 * The reqId of the open request the host answered `ok` to. Results with another
 * reqId are discarded; a result without a reqId is delivered only during the QA candidate period.
 */
let openedRecoveryReqId: number | null = null

export async function nativeRecoveryOpen(): Promise<{ ok: true } | { ok: false; reason: string }> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { ok: false, reason: 'native_unavailable' }
	const reqId = nextReqId()
	const answer = await requestNativeAck({ type: NATIVE_RECOVERY_OPEN_COMMAND }, OPEN_TIMEOUT_MS, reqId)
	if (answer.kind !== 'payload') return { ok: false, reason: answer.kind }
	const p = answer.payload as { type?: unknown; ok?: unknown; error?: unknown }
	if (p.type === 'ack' && p.ok === true) {
		openedRecoveryReqId = reqId
		beginWatch()
		return { ok: true }
	}
	return { ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'bad_ack' }
}

/**
 * Native account creation. `nativeAccountCreateOpen` is the proposed name (interface maintainers' name; not yet confirmed in
 * the spec). The shell generates the key and registers; the page never generates a key. Until the native side answers ok,
 * the page shows the unavailable notice.
 */
export const NATIVE_ACCOUNT_CREATE_OPEN_COMMAND = 'nativeAccountCreateOpen'

/** The reqId of the open request that the host answered `ok` to; a result event with another reqId is discarded (a). */
let openedCreateReqId: number | null = null

/**
 * the open carries the account (BeamioTag or EOA address, a public identifier). Actual shapes:
 * - an already bound account: ack ok:true page:"none", then the nested result event with code already_bound (Android NativeOpenRules.kt:168–172,
 * 188–193; iOS BeamioConetChatModule.swift:3016–3020, 3164–3166). The result event opens the native recovery; no new EOA;
 * - lookup unavailable: ack ok:true page:"none", then the nested result event with code lookup_unavailable (retry later; nothing is created).
 * The open ack with ok:false reason already_bound is NOT sent by the new SDKs (f6b477b4, 5ffda0f); it is kept as a compatibility
 * branch for an unverified old shell (旧壳未核). Do not rely on it for the new shells.
 */
/**
 * The `page` field of an ok open ack (and.3): `opened` means the first screen is open; `none` means no page was opened
 * (the result event then decides: already_bound opens the recovery, lookup_unavailable asks to try later). Any other value, or no field, is absent.
 */
export type NativeAccountCreatePage = 'opened' | 'none'

/** The `walletStatus` of a not_available ack: G0 may be tried again later; G1 and G2 are unavailable and do not retry. */
export type NativeWalletStatus = 'G0' | 'G1' | 'G2'

export type NativeAccountCreateOpenResult =
	| { ok: true; page?: NativeAccountCreatePage }
	| { ok: false; reason: string; walletStatus?: NativeWalletStatus }

/** Reads an open ack. Pure, so the rules are tested without the bridge. A failed ack never carries `page`. */
export function parseAccountCreateOpenAck(
	p: { type?: unknown; ok?: unknown; error?: unknown; reason?: unknown; page?: unknown; walletStatus?: unknown } | null | undefined,
): NativeAccountCreateOpenResult {
	if (!p || typeof p !== 'object') return { ok: false, reason: 'bad_ack' }
	if (p.type === 'ack' && p.ok === true) {
		const page: NativeAccountCreatePage | undefined = p.page === 'opened' || p.page === 'none' ? p.page : undefined
		return { ok: true, page }
	}
	const walletStatus: NativeWalletStatus | undefined =
		p.walletStatus === 'G0' || p.walletStatus === 'G1' || p.walletStatus === 'G2' ? p.walletStatus : undefined
	// the cause is read from `error`; `reason` is accepted as well.
	const cause = typeof p.error === 'string' && p.error ? p.error : typeof p.reason === 'string' && p.reason ? p.reason : 'bad_ack'
	return { ok: false, reason: cause, walletStatus }
}

/**
 * Pre-send check of `account`: a BeamioTag of 1 to 64 visible ASCII characters (0x21–0x7E) that does not
 * start with 0x, or an EOA address of 0x plus 40 lowercase hex digits. The native side stays the authority; a value that fails
 * here is never sent.
 */
export function isValidNativeAccount(account: string): boolean {
	if (/^0x[0-9a-f]{40}$/.test(account)) return true
	return /^[\x21-\x7E]{1,64}$/.test(account) && !account.startsWith('0x')
}

export async function nativeAccountCreateOpen(account: string): Promise<NativeAccountCreateOpenResult> {
	if (!isValidNativeAccount(account)) return { ok: false, reason: 'bad_request' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { ok: false, reason: 'native_unavailable' }
	const reqId = nextReqId()
	const answer = await withoutGlobalNoKeyLock(() =>
		requestNativeAck({ type: NATIVE_ACCOUNT_CREATE_OPEN_COMMAND, account }, OPEN_TIMEOUT_MS, reqId),
	)
	if (answer.kind !== 'payload') return { ok: false, reason: answer.kind }
	const result = parseAccountCreateOpenAck(answer.payload as { type?: unknown; ok?: unknown; error?: unknown; page?: unknown; walletStatus?: unknown })
	if (result.ok) openedCreateReqId = reqId
	return result
}

/** Test seam and reset: the reqId of the opened create request, or null. */
export function openedNativeCreateReqId(): number | null {
	return openedCreateReqId
}

/**
 * Accepts a `nativeAccountCreateResult` payload only when it is valid: the type matches; the reqId is the opened
 * one; only the fields type, reqId, code, eoa are present; the code is one of the five; eoa is present only for ok and is a
 * lower-case 0x address. Anything else is discarded (null). The log names the reason only, never a value.
 */
/**
 * (OB-2…OB-4),: the write_failed reason vocabulary. A reason outside it, or none, is undefined (the conservative case:
 * no completion, no retry button, an explanation, and a reread before any further action). The native shells do not send it yet.
 */
export const WRITE_FAILED_REASON_VOCABULARY = ['internal_state', 'storage_write', 'rollback_pending', 'old_copy_unverified'] as const
export type WriteFailedReason = (typeof WRITE_FAILED_REASON_VOCABULARY)[number]

export type NativeCreateAccepted =
	| { code: NativeAccountCreateResultCode; eoa?: string; reason?: WriteFailedReason }
	| { code: 'shape_violation'; reason: 'ok_code_mismatch' }

/** Fields allowed at the top level of a nested create result. */
const CREATE_RESULT_TOP_KEYS: ReadonlySet<string> = new Set(['type', 'reqId', 'ok', 'result'])
/** Fields allowed inside `result`. The three W fields are accepted on ok only and stripped at once. */
const CREATE_RESULT_KEYS: ReadonlySet<string> = new Set(['code', 'eoa', 'cleanupPending', 'reason'])
const CREATE_RESULT_W_KEYS: ReadonlySet<string> = new Set(['privateKeyArmor', 'mnemonicPhrase', 'recoveryWords'])

/**
 * Accepts a nested `nativeAccountCreateResult` payload. Shape: `{type, reqId, ok, result:{code, eoa?, cleanupPending?, W?}}`.
 * - the reqId must be the opened one; top-level keys are limited to type, reqId, ok, result;
 * - inside result: code, eoa, cleanupPending; the W fields only when ok, and they are dropped here (never kept or logged);
 * - `ok` must equal (code === 'ok'); a mismatch is a shape violation (the caller ends the wait and offers a retry);
 * - ok needs a lower-case 0x eoa; already_exists and not_ready may carry an eoa, which is dropped (never a success basis);
 * other non-ok codes must not carry an eoa.
 * Anything else is discarded (null). The log names the reason only, never a value.
 */
export function acceptNativeCreateResult(p: unknown, opened: number | null): NativeCreateAccepted | null {
	if (!p || typeof p !== 'object') return null
	const o = p as Record<string, unknown>
	if (o.type !== NATIVE_ACCOUNT_CREATE_RESULT_EVENT) return null
	if (opened === null || o.reqId !== opened) return null
	for (const k of Object.keys(o)) if (!CREATE_RESULT_TOP_KEYS.has(k)) return null
	if (typeof o.ok !== 'boolean') return null
	const r = o.result
	if (!r || typeof r !== 'object' || Array.isArray(r)) return null
	const rr = r as Record<string, unknown>
	for (const k of Object.keys(rr)) {
		if (CREATE_RESULT_KEYS.has(k)) continue
		if (CREATE_RESULT_W_KEYS.has(k) && o.ok === true) continue
		return null
	}
	const code = rr.code
	if (typeof code !== 'string' || !(NATIVE_ACCOUNT_CREATE_RESULT_CODES as readonly string[]).includes(code)) return null
	if (o.ok !== (code === 'ok')) return { code: 'shape_violation', reason: 'ok_code_mismatch' }
	if (code === 'ok') {
		if (typeof rr.eoa !== 'string' || !/^0x[0-9a-f]{40}$/.test(rr.eoa)) return null
		return { code: 'ok', eoa: rr.eoa }
	}
	// the reason is read only on write_failed; any other code that carries it is a shape violation (null), checked before the early returns
	if (rr.reason !== undefined && code !== 'write_failed') return null
	if (code === 'already_exists' || code === 'not_ready') return { code: code as NativeAccountCreateResultCode }
	if (rr.eoa !== undefined) return null
	if (code === 'write_failed') {
		const reason = (WRITE_FAILED_REASON_VOCABULARY as readonly unknown[]).includes(rr.reason) ? (rr.reason as WriteFailedReason) : undefined
		return reason ? { code: 'write_failed', reason } : { code: 'write_failed' }
	}
	return { code: code as NativeAccountCreateResultCode }
}

/** Native wallet state (walletStatus): the ack carries `result.status`; with a key, `accountKey` is `eoa:workspace` (public). */
export const NATIVE_WALLET_STATUS_COMMAND = 'walletStatus'
export type NativeWalletState =
	| { status: 'no_key' | 'unknown' }
	| { status: 'not_ready'; notReadyReason?: 'g1_uninitialized' | 'key_only' | 'unreadable' }
	| { status: 'locked' | 'unlocked'; eoa: string }
	| { status: 'phrase_only'; eoa: string }

/**
 * Why a walletStatus answer is unknown, as a category: field names and codes only. Null for a usable answer.
 */
export function walletStatusUnknownReason(payload: { type?: unknown; ok?: unknown; result?: unknown } | null, answered: boolean): string | null {
	if (!answered) return 'not_answered'
	if (!payload || payload.type !== 'ack' || payload.ok !== true) return 'envelope_not_ok'
	if (!payload.result) return 'result_missing'
	const result = payload.result
	if (typeof result !== 'object' || Array.isArray(result)) return 'result_not_object'
	const st = (result as { status?: unknown }).status
	if (typeof st !== 'string') return 'status_missing'
	if (!WALLET_STATUS_NAMES.has(st)) return `status_unrecognised:${diagnosticCode(st)}`
	return null
}
const WALLET_STATUS_NAMES: ReadonlySet<string> = new Set(['no_key', 'not_ready', 'locked', 'unlocked', 'unknown', 'timeout', 'unavailable'])

export async function queryNativeWalletStatus(): Promise<NativeWalletState> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered) {
		publishNativePwaLog('warn', `[walletStatus] unknown: reason=${walletStatusUnknownReason(null, false)}`)
		return { status: 'unknown' }
	}
	const answer = await requestNativeAck({ type: NATIVE_WALLET_STATUS_COMMAND }, OPEN_TIMEOUT_MS)
	if (answer.kind !== 'payload') {
		publishNativePwaLog('warn', `[walletStatus] unknown: reason=no_payload answer=${answer.kind}`)
		return { status: 'unknown' }
	}
	const p = answer.payload as { type?: unknown; ok?: unknown; result?: unknown }
	const why = walletStatusUnknownReason(p, true)
	if (why !== null) {
		const envelope = Object.keys(p as Record<string, unknown>).filter((k) => /^[A-Za-z_]{1,30}$/.test(k)).sort().join(',')
		publishNativePwaLog('warn', `[walletStatus] unknown: reason=${why} envelope=${envelope}`)
		return { status: 'unknown' }
	}
	return parseWalletStatusResult(p.result, (a) => ethers.isAddress(a))
}

/**
 * The native wallet state for the account judgement: `walletState` of the `passcodeStatus` answer, the only
 * basis of the judgement. A native build that does not report it yet answers `not_reported` (the gate keeps the existing route); a
 * refused or unreadable answer is `unknown` (undetermined). The answer carries the state only, never material.
 */
/**
 * The start-up pre-read (spec, items 42(2) and 46(4)): the PWA asks the native side what it read in advance, once the PWA has
 * confirmed that it holds no valid mnemonic. Replies: valid (a valid mnemonic whose derived address is eoa), absent (the native side read
 * and confirmed there is none), unknown (an error, a timeout, a pre-read not finished, or anything else). Only absent is "confirmed empty".
 */
export const NATIVE_MNEMONIC_PREREAD_COMMAND = 'nativeMnemonicPreread'
/**
 * `unknown` is never absent. `reason: 'unsupported'` is only the bridge's `unknown_command` (a shell with no pre-read): the caller falls
 * back to the walletStatus route instead of waiting. Every other unknown is a retryable startup wait.
 */
/** `locked` (HC-LOCK L-PRE): the native lock answered; not absent, not unknown-by-timeout. The caller takes the unlock branch. */
export type MnemonicPreread = { kind: 'valid'; eoa: string; phrase: string } | { kind: 'absent' } | { kind: 'locked' } | { kind: 'unknown'; reason?: 'unsupported' }

/**
 * The pre-read request (spec item 60(1)): it carries `seq`, the page's shared persistent transaction number (the same sequence as
 * pwaWalletSync and pwaEmptySignal). The pre-read compares the number and never records it (item 60(4)).
 */
export function buildNativeMnemonicPrereadCommand(seq: number): { type: string; seq: number } {
	return { type: NATIVE_MNEMONIC_PREREAD_COMMAND, seq }
}

/**
 * Maps one pre-read answer to valid / absent / unknown. The answer's result carries `state` (spec item 59(2)(a)): `{state:"valid", eoa, phrase}`,
 * `{state:"absent"}`, `{state:"unknown"}`. Anything not in the closed set is unknown; a valid answer must derive its EOA. Every refusal
 * (`ok:false`: untrusted_source, stale_seq, bad_request, or any other error) is unknown, never absent: the page keeps the start-up wait.
 */
export function prereadFromAnswer(answer: { kind: string; payload?: unknown }): MnemonicPreread {
	if (answer.kind !== 'payload') return { kind: 'unknown' }
	const p = (answer.payload ?? null) as { type?: unknown; ok?: unknown; result?: unknown; error?: unknown } | null
	// an unknown_command is the one refusal that means "this shell has no pre-read" (the caller falls back); every other refusal stays bare unknown
	if (p && p.type === 'ack' && p.ok !== true && p.error === 'locked') return { kind: 'locked' }
	if (!p || p.type !== 'ack' || p.ok !== true) return p?.error === 'unknown_command' ? { kind: 'unknown', reason: 'unsupported' } : { kind: 'unknown' }
	const r = (p.result ?? null) as { state?: unknown; eoa?: unknown; phrase?: unknown } | null
	const state = typeof p.result === 'string' ? p.result : typeof r?.state === 'string' ? r.state : ''
	if (state === 'absent' || state === 'explicit_empty') return { kind: 'absent' }
	if (state !== 'valid' || !r) return { kind: 'unknown' }
	if (typeof r.eoa !== 'string' || !isMnemonicPhrase(r.phrase)) return { kind: 'unknown' }
	try {
		const derived = ethers.Wallet.fromPhrase(r.phrase).address.toLowerCase()
		return derived === r.eoa.toLowerCase() ? { kind: 'valid', eoa: derived, phrase: r.phrase.trim() } : { kind: 'unknown' }
	} catch {
		return { kind: 'unknown' }
	}
}

/**
 * The pre-read transport (2026-11-17, Android shell's shape; E6 trusted bridge only):
 * - window.BeamioShellRecord (WebMessage, trusted main frame) when injected: the request {type, reqId, seq}, the ack as the shell sends it;
 * - Android without the injection: not_supported (unknown, kept, retryable). No fallback to the JS interface (CashTreesAndroid.chatModuleCommand);
 * - iOS and other shells: unchanged, the native ack path (requestNativeAck).
 */
async function prereadSend(cmd: { type: string; seq: number }, timeoutMs: number): Promise<{ kind: string; payload?: unknown }> {
	if (shellRecordTransportKind() === 'window') {
		return sendShellWalletSyncCommand({ type: cmd.type, reqId: nextReqId(), seq: cmd.seq }, timeoutMs)
	}
	if (getCashTreesNativeNfcHost() === 'android') return { kind: 'not_supported' }
	return requestNativeAck(cmd, timeoutMs)
}

/**
 * Asks the native side for the pre-read. Each call draws a new number from the shared sequence, so a retry (the start-up wait's retry)
 * is never older than the request before it. `send` is injectable for tests; the app uses prereadSend (above).
 */
export async function queryNativeMnemonicPreread(
	nextSeq: () => number = nextShellTxSeq,
	send: (cmd: { type: string; seq: number }, timeoutMs: number) => Promise<{ kind: string; payload?: unknown }> = prereadSend,
): Promise<MnemonicPreread> {
	const cmd = buildNativeMnemonicPrereadCommand(nextSeq())
	publishNativePwaLog('info', `[preread] sent cmd=${cmd.type} seq=${cmd.seq}`)
	const answer = await send(cmd, OPEN_TIMEOUT_MS)
	// A pre-read the shell cannot answer (not_supported) is a definite old shell: the legacy judgement, not a retry.
	const out = answer.kind === 'not_supported' ? { kind: 'unknown' as const, reason: 'unsupported' as const } : prereadFromAnswer(answer)
	// the result state only: never the phrase, never an address
	publishNativePwaLog('info', `[preread] result cmd=${cmd.type} seq=${cmd.seq} state=${out.kind}${out.kind === 'unknown' && out.reason ? ` reason=${out.reason}` : ''}`)
	return out
}

export const NATIVE_PASSCODE_STATUS_COMMAND = 'passcodeStatus'
/**
 * One `passcodeStatus` answer read once: `walletState` (as before) and the `hasKey` marker. `hasKey` is `unknown` when the answer is
 * missing, refused or not a boolean; `not_reported` when the build does not send the field (an older shell).
 */
export interface NativePasscodeReport {
	walletState: NativeWalletStateReport | 'not_reported'
	hasKey: boolean | 'not_reported' | 'unknown'
}

/**
 * Why a passcodeStatus answer is unknown, as a category (an unrecognised shape is a clear diagnostic, never a silent
 * read_failed). Field names and codes only; no value is logged. Returns null for a usable answer.
 */
export function passcodeUnknownReason(payload: { type?: unknown; ok?: unknown; result?: unknown } | null, answered: boolean): string | null {
	if (!answered) return 'not_answered'
	if (!payload || payload.type !== 'ack' || payload.ok !== true) return 'envelope_not_ok'
	const result = payload.result
	if (!result || typeof result !== 'object' || Array.isArray(result)) return 'result_not_object'
	const keys = Object.keys(result as Record<string, unknown>)
	const extra = keys.filter((k) => !PASSCODE_STATUS_FIELD_NAMES.has(k))
	if (extra.length) return `extra_field:${extra.map((k) => (/^[A-Za-z_]{1,30}$/.test(k) ? k : 'other')).sort().join(',')}`
	const state = (result as { walletState?: unknown }).walletState
	if (state !== undefined && (typeof state !== 'string' || !PASSCODE_WALLET_STATE_NAMES.has(state))) {
		return `wallet_state_unrecognised:${diagnosticCode(state)}`
	}
	const hasKey = (result as { hasKey?: unknown }).hasKey
	if (hasKey !== undefined && typeof hasKey !== 'boolean') return 'has_key_not_boolean'
	return null
}
const PASSCODE_STATUS_FIELD_NAMES: ReadonlySet<string> = new Set(['set', 'locked', 'hasKey', 'walletState'])
const PASSCODE_WALLET_STATE_NAMES: ReadonlySet<string> = new Set(['present', 'absent', 'not_ready', 'locked', 'unavailable', 'corrupt'])

export async function queryNativePasscodeStatus(): Promise<NativePasscodeReport> {
	const unknown: NativePasscodeReport = { walletState: 'unknown', hasKey: 'unknown' }
	const probe = await probeNativeCapabilities()
	if (!probe.answered) {
		publishNativePwaLog('warn', `[passcodeStatus] unknown: reason=${passcodeUnknownReason(null, false)}`)
		return unknown
	}
	const answer = await requestNativeAck({ type: NATIVE_PASSCODE_STATUS_COMMAND }, OPEN_TIMEOUT_MS)
	if (answer.kind !== 'payload') {
		publishNativePwaLog('warn', `[passcodeStatus] unknown: reason=no_payload answer=${answer.kind}`)
		return unknown
	}
	const p = answer.payload as { type?: unknown; ok?: unknown; result?: unknown }
	const why = passcodeUnknownReason(p, true)
	if (why !== null) {
		const envelope = Object.keys(p as Record<string, unknown>).filter((k) => /^[A-Za-z_]{1,30}$/.test(k)).sort().join(',')
		publishNativePwaLog('warn', `[passcodeStatus] unknown: reason=${why} envelope=${envelope}`)
		return unknown
	}
	const walletState = parsePasscodeStatus(p.result)
	const r = p.result as { hasKey?: unknown } | null
	const hasKey: NativePasscodeReport['hasKey'] =
		walletState === 'unknown' ? 'unknown' : !r || typeof r !== 'object' || r.hasKey === undefined ? 'not_reported' : typeof r.hasKey === 'boolean' ? r.hasKey : 'unknown'
	return { walletState, hasKey }
}

export async function queryNativeWalletState(): Promise<NativeWalletStateReport | 'not_reported'> {
	return (await queryNativePasscodeStatus()).walletState
}

/** Result codes of the native account-creation page. */
export const NATIVE_ACCOUNT_CREATE_RESULT_EVENT = 'nativeAccountCreateResult'
export const NATIVE_ACCOUNT_CREATE_RESULT_CODES = [
	'ok',
	'cancelled',
	'already_exists',
	'not_ready',
	'write_failed',
	'readback_failed',
	//3: no eoa with these two codes.
	'already_bound',
	'lookup_unavailable',
] as const
export type NativeAccountCreateResultCode = (typeof NATIVE_ACCOUNT_CREATE_RESULT_CODES)[number]

/** Subscribes to `nativeAccountCreateResult`. Unknown codes are ignored. Returns the unsubscribe function. */
export function onNativeAccountCreateResult(listener: (result: NativeCreateAccepted) => void): () => void {
	if (typeof window === 'undefined') return () => undefined
	const handler = (ev: Event) => {
		const p = eventPayloadOf(ev)
		if (!p || p.type !== NATIVE_ACCOUNT_CREATE_RESULT_EVENT) return
		const accepted = acceptNativeCreateResult(p, openedCreateReqId)
		if (!accepted) return
		listener(accepted)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, handler)
	return () => {
		for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, handler)
	}
}

/**
 * Subscribes to `nativeRecoveryResult`. Unknown codes are ignored. A non-ok result keeps the subscription; `ok` ends it. Returns
 * the unsubscribe function.
 */
export function onNativeRecoveryResult(listener: (result: NativeRecoveryResult) => void): () => void {
	if (typeof window === 'undefined') return () => undefined
	subscribers.push(listener)
	startListening()
	return () => {
		const at = subscribers.indexOf(listener)
		if (at >= 0) subscribers.splice(at, 1)
		stopListeningIfIdle()
	}
}
