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
import { parsePasscodeStatus, type NativeWalletState as NativeWalletStateReport } from './accountJudgement'
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
	// B7 (PM ruling): a result with a reqId that is not the open request's is discarded (fail closed).
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
 * The reqId of the open request the host answered `ok` to (B7, Chat SDK interface r3rz §25.52Y.48). Results with another
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
 * Native account creation. `nativeAccountCreateOpen` is the proposed name (interface owner's; not yet confirmed in
 * the spec). The shell generates the key and registers; the page never generates a key. Until the native side answers ok,
 * the page shows the unavailable notice.
 */
export const NATIVE_ACCOUNT_CREATE_OPEN_COMMAND = 'nativeAccountCreateOpen'

/** The reqId of the open request that the host answered `ok` to; a result event with another reqId is discarded (a). */
let openedCreateReqId: number | null = null

/**
 * the open carries the account (BeamioTag or EOA address, a public identifier). The native side answers `already_bound`
 * (open the native recovery instead; no new EOA) or `lookup_unavailable` (retry later; nothing is created) before the first screen.
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
	p: { type?: unknown; ok?: unknown; error?: unknown; page?: unknown; walletStatus?: unknown } | null | undefined,
): NativeAccountCreateOpenResult {
	if (!p || typeof p !== 'object') return { ok: false, reason: 'bad_ack' }
	if (p.type === 'ack' && p.ok === true) {
		const page: NativeAccountCreatePage | undefined = p.page === 'opened' || p.page === 'none' ? p.page : undefined
		return { ok: true, page }
	}
	const walletStatus: NativeWalletStatus | undefined =
		p.walletStatus === 'G0' || p.walletStatus === 'G1' || p.walletStatus === 'G2' ? p.walletStatus : undefined
	return { ok: false, reason: typeof p.error === 'string' && p.error ? p.error : 'bad_ack', walletStatus }
}

export async function nativeAccountCreateOpen(account: string): Promise<NativeAccountCreateOpenResult> {
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
export function acceptNativeCreateResult(
	p: unknown,
	opened: number | null,
): { code: NativeAccountCreateResultCode; eoa?: string } | null {
	if (!p || typeof p !== 'object') return null
	const o = p as Record<string, unknown>
	if (o.type !== NATIVE_ACCOUNT_CREATE_RESULT_EVENT) return null
	if (opened === null || o.reqId !== opened) return null
	for (const k of Object.keys(o)) if (k !== 'type' && k !== 'reqId' && k !== 'code' && k !== 'eoa') return null
	const code = o.code
	if (typeof code !== 'string' || !(NATIVE_ACCOUNT_CREATE_RESULT_CODES as readonly string[]).includes(code)) return null
	if (code === 'ok') {
		if (typeof o.eoa !== 'string' || !/^0x[0-9a-f]{40}$/.test(o.eoa)) return null
		return { code: 'ok', eoa: o.eoa }
	}
	if (o.eoa !== undefined) return null
	return { code: code as NativeAccountCreateResultCode }
}

/** Native wallet state (walletStatus): the ack carries `result.status`; with a key, `accountKey` is `eoa:workspace` (public). */
export const NATIVE_WALLET_STATUS_COMMAND = 'walletStatus'
export type NativeWalletState =
	| { status: 'no_key' | 'unknown' }
	| { status: 'not_ready'; notReadyReason?: 'g1_uninitialized' | 'unreadable' }
	| { status: 'locked' | 'unlocked'; eoa: string }

export async function queryNativeWalletStatus(): Promise<NativeWalletState> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return { status: 'unknown' }
	const answer = await requestNativeAck({ type: NATIVE_WALLET_STATUS_COMMAND }, OPEN_TIMEOUT_MS)
	if (answer.kind !== 'payload') return { status: 'unknown' }
	const p = answer.payload as { type?: unknown; ok?: unknown; result?: { status?: unknown; accountKey?: unknown; notReadyReason?: unknown } }
	if (p.type !== 'ack' || p.ok !== true || !p.result) return { status: 'unknown' }
	const st = p.result.status
	if (st === 'no_key') return { status: st }
	// `notReadyReason` is read only on a not_ready answer; any other value, or none, is unreadable (no field).
	if (st === 'not_ready') {
		const reason = p.result.notReadyReason
		return reason === 'g1_uninitialized' || reason === 'unreadable' ? { status: st, notReadyReason: reason } : { status: st }
	}
	if (st === 'locked' || st === 'unlocked') {
		const key = typeof p.result.accountKey === 'string' ? p.result.accountKey : ''
		const eoa = key.split(':')[0]?.trim() ?? ''
		return ethers.isAddress(eoa) ? { status: st, eoa: eoa.toLowerCase() } : { status: 'unknown' }
	}
	return { status: 'unknown' }
}

/**
 * The native wallet state for the account judgement: `walletState` of the `passcodeStatus` answer, the only
 * basis of the judgement. A native build that does not report it yet answers `not_reported` (the gate keeps the existing route); a
 * refused or unreadable answer is `unknown` (undetermined). The answer carries the state only, never material.
 */
export const NATIVE_PASSCODE_STATUS_COMMAND = 'passcodeStatus'
export async function queryNativeWalletState(): Promise<NativeWalletStateReport | 'not_reported'> {
	const probe = await probeNativeCapabilities()
	if (!probe.answered) return 'unknown'
	const answer = await requestNativeAck({ type: NATIVE_PASSCODE_STATUS_COMMAND }, OPEN_TIMEOUT_MS)
	if (answer.kind !== 'payload') return 'unknown'
	const p = answer.payload as { type?: unknown; ok?: unknown; result?: unknown }
	if (p.type !== 'ack' || p.ok !== true) return 'unknown'
	return parsePasscodeStatus(p.result)
}

/** Result codes of the native account-creation page. */
export const NATIVE_ACCOUNT_CREATE_RESULT_EVENT = 'nativeAccountCreateResult'
export const NATIVE_ACCOUNT_CREATE_RESULT_CODES = [
	'ok',
	'cancelled',
	'already_exists',
	'write_failed',
	'readback_failed',
	//3: no eoa with these two codes.
	'already_bound',
	'lookup_unavailable',
] as const
export type NativeAccountCreateResultCode = (typeof NATIVE_ACCOUNT_CREATE_RESULT_CODES)[number]

/** Subscribes to `nativeAccountCreateResult`. Unknown codes are ignored. Returns the unsubscribe function. */
export function onNativeAccountCreateResult(listener: (result: { code: NativeAccountCreateResultCode; eoa?: string }) => void): () => void {
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
