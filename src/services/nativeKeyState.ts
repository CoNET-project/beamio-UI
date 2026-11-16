/**
 * Native wallet key state and the import route.
 *
 * - A shell with no key for the account answers a wallet or chat command with ack `{type: "ack", reqId, ok: false, error: "no_key"}`.
 *   `installNativeNoKeyWatcher` reports that, and the gate shows the locked page with the import route. Nothing is asked for or
 *   received here: no key, mnemonic or PGP armor is read by the page.
 * - `openNativeKeyImport` sends `{type: "nativeImportOpen", reqId}` (no other field) on the chat-module channel. The shell opens
 * its own secure import screen and answers with an ack. The key is typed only on that native screen.
 *
 * Wire format: the same chat-module channel the native chat transports use. iOS: `CashTreesIOS.chatModuleCommand({action,
 * command})`. Android: `CashTreesAndroid.chatModuleCommand(JSON)`. Events come back on `cashtreesios` / `cashtreesandroid` as
 * `chatModuleEvent` details. The transfer channel is retired and is not used here.
 */
import { postAndroidChatCommand } from '../utils/androidChatChannel'

export const NO_KEY_ERROR = 'no_key'
export const NATIVE_IMPORT_OPEN = 'nativeImportOpen'
export const NATIVE_EVENT_NAMES = ['cashtreesios', 'cashtreesandroid'] as const
/** Import acks use their own reqId range, so they never match a pending request of a chat transport. */
const IMPORT_REQ_BASE = 900_000_000
/**
 * Gate queries use one reqId range: identityPublic and the PGP evaluate, restore and create commands.
 * A refusal in this range (for example `no_key` from a query) never decides the app entry; the entry reads walletStatus.
 */
export const NATIVE_QUERY_REQ_BASE = 950_000_000
export const NATIVE_QUERY_REQ_END = 1_000_000_000
export const isNativeQueryReqId = (reqId: unknown): boolean =>
	typeof reqId === 'number' && reqId >= NATIVE_QUERY_REQ_BASE && reqId < NATIVE_QUERY_REQ_END
const IMPORT_TIMEOUT_MS = 10_000
let importSeq = 0
/** reqId of the last import open (Y.95): a nativeImportResult is accepted only with this reqId. */
let openedImportReqId: number | null = null
export function lastOpenedImportReqId(): number | null {
	return openedImportReqId
}

export type NativeImportOpenResult = 'opened' | 'not_supported' | 'not_available' | 'failed' | 'unavailable' | 'timeout'

type Loose = Record<string, unknown>

/** The payload of a `chatModuleEvent` detail, read the same way the chat transports read it. */
export function eventPayloadOf(ev: Event): Loose | null {
	const detail = (ev as CustomEvent).detail as Loose | undefined
	if (!detail || typeof detail !== 'object') return null
	if (detail.action !== 'chatModuleEvent') return null
	const payload = detail.event ?? detail.payload ?? detail
	return payload && typeof payload === 'object' ? (payload as Loose) : null
}

/** Depth of in-flight requests whose own `no_key` answer is handled by the caller (not by the global lock screen). */
let quietNoKeyDepth = 0

/** Runs one request whose `no_key` answer must not raise the global import-required screen (e.g. account creation). */
export async function withoutGlobalNoKeyLock<T>(fn: () => Promise<T>): Promise<T> {
	quietNoKeyDepth += 1
	try {
		return await fn()
	} finally {
		quietNoKeyDepth -= 1
	}
}

export function isNoKeyAck(payload: unknown): boolean {
	if (!payload || typeof payload !== 'object') return false
	const p = payload as Loose
	return p.type === 'ack' && p.ok === false && p.error === NO_KEY_ERROR
}

/** Calls `onNoKey` for each `no_key` ack from the shell. Returns the remover, or null when there is no window. */
export function installNativeNoKeyWatcher(onNoKey: () => void): (() => void) | null {
	if (typeof window === 'undefined') return null
	const listener = (ev: Event) => {
		const payload = eventPayloadOf(ev)
		// identityPublic's refusal does not decide the app entry: the gate reads walletStatus instead.
		if (payload && isNoKeyAck(payload) && quietNoKeyDepth === 0 && !isNativeQueryReqId(payload.reqId)) onNoKey()
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
	return () => {
		for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
	}
}

/** Sends one chat-module command through the running shell. False when no shell channel exists. */
export function postChatModuleCommand(cmd: Loose): boolean {
	const ios = (window as unknown as { CashTreesIOS?: { chatModuleCommand?: unknown } }).CashTreesIOS
	if (ios && typeof ios === 'object' && typeof ios.chatModuleCommand === 'function') {
		// Same wire format as the iOS chat transport.
		;(ios as { chatModuleCommand: (p: Loose) => void }).chatModuleCommand({ action: 'chatModuleCommand', command: cmd })
		return true
	}
	// the Android path uses window.BeamioChat when present, else CashTreesAndroid.chatModuleCommand.
	return postAndroidChatCommand(cmd)
}

/**
 * The global destroy the logout and lock path sends. It tears the native chat session down, so it must
 * carry a valid reqId (an integer, 0 to 2^53-1). A destroy without one is answered bad_request and does nothing.
 */
const DESTROY_REQ_BASE = 790_000_000
let destroySeq = 0
export function buildGlobalDestroyCommand(): { type: 'destroy'; reqId: number } {
	destroySeq += 1
	return { type: 'destroy', reqId: DESTROY_REQ_BASE + destroySeq }
}

/** Sends the logout / lock teardown through the running shell. False when no shell channel takes it. */
export function sendGlobalDestroyOnLogout(): boolean {
	return postChatModuleCommand(buildGlobalDestroyCommand())
}

/**
 * Asks the shell to open its native import screen. Resolves with the ack result only; the imported key never reaches this page.
 * Outside a shell it resolves `unavailable` at once.
 */
export function openNativeKeyImport(timeoutMs: number = IMPORT_TIMEOUT_MS): Promise<NativeImportOpenResult> {
	if (typeof window === 'undefined') return Promise.resolve('unavailable')
	importSeq += 1
	const reqId = IMPORT_REQ_BASE + importSeq
	openedImportReqId = reqId
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const done = (result: NativeImportOpenResult) => {
			for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
			if (timer !== undefined) clearTimeout(timer)
			resolve(result)
		}
		const listener = (ev: Event) => {
			const payload = eventPayloadOf(ev)
			if (!payload || payload.type !== 'ack' || Number(payload.reqId) !== reqId) return
			if (payload.ok === true) {
				done('opened')
				return
			}
			// not_supported: the shell has no import page. not_available: the page cannot open right now.
			const error = payload.error
			done(error === 'not_supported' ? 'not_supported' : error === 'not_available' ? 'not_available' : 'failed')
		}
		for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
		timer = setTimeout(() => done('timeout'), timeoutMs)
		let sent = false
		try {
			sent = postChatModuleCommand({ type: NATIVE_IMPORT_OPEN, reqId })
		} catch {
			sent = false
		}
		if (!sent) done('unavailable')
	})
}

/** Wallet state from `walletStatus`: G0 `no_key`, G1 `not_ready`, G2 `locked` or `unlocked`. */
export type NativeWalletStatus = 'no_key' | 'not_ready' | 'locked' | 'unlocked' | 'unknown' | 'unavailable'
const WALLET_STATUS_VALUES: readonly string[] = ['no_key', 'not_ready', 'locked', 'unlocked']

/**
 * Reads `walletStatus` again after the native import page has closed. The import page itself returns no result
 * event, so this is the only way to learn the new state.
 *
 * Reply shape: an ack envelope with the data in `result`: `{type: "ack", reqId, ok: true, result: {status}}`.
 * Only `result.status` is read. The top-level `status` is not read, and `ok: false` with `error: "no_key"` is not G0 here: `walletStatus`
 * answers G0 with `ok: true, result: {status: "no_key"}`. `accountKey` is never read. Any other reply is `unknown`; a missing
 * shell or a timeout is `unavailable`.
 */
export function readNativeWalletStatus(timeoutMs: number = IMPORT_TIMEOUT_MS): Promise<NativeWalletStatus> {
	if (typeof window === 'undefined') return Promise.resolve('unavailable')
	importSeq += 1
	const reqId = IMPORT_REQ_BASE + importSeq
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const done = (result: NativeWalletStatus) => {
			for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, listener)
			if (timer !== undefined) clearTimeout(timer)
			resolve(result)
		}
		const listener = (ev: Event) => {
			const payload = eventPayloadOf(ev)
			if (!payload || payload.type !== 'ack' || Number(payload.reqId) !== reqId) return
			const result = payload.ok === true ? (payload.result as Loose | undefined) : undefined
			const raw = result && typeof result === 'object' ? result.status : undefined
			if (typeof raw === 'string' && WALLET_STATUS_VALUES.includes(raw)) return done(raw as NativeWalletStatus)
			done('unknown')
		}
		for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, listener)
		timer = setTimeout(() => done('unavailable'), timeoutMs)
		let sent = false
		try {
			sent = postChatModuleCommand({ type: 'walletStatus', reqId })
		} catch {
			sent = false
		}
		if (!sent) done('unavailable')
	})
}
