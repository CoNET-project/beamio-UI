/**
 * The page's one transport for the shell record (replies). shellRecordRead and shellRecordWrite send
 * through `sendShellRecordCommand` only. The page never calls the chat module or the window object for them.
 *
 * The choice, in order
 * 1. `window.BeamioShellRecord` is injected (defined, even if it cannot be used): only it is used. There is no fallback to the chat
 * channel. If it cannot be used the answer is `unavailable`.
 * 2. Not injected, iOS, and the chat module channel exists: the chat module channel.
 * 3. Not injected, Android: `not_supported`. Android never uses the chat module channel for the shell record.
 * 4. No channel (a browser, or a shell without the channel): `none`.
 *
 * Replies: they come on the injected object's `onmessage` (or the chat module event, on iOS), in the ack envelope, and are
 * matched by reqId. A reply with an unknown reqId, a duplicate, a non-ack, or a malformed one is ignored and the request keeps waiting.
 * The first valid reply wins. A request times out after 10 seconds (`timeout`, a page-side answer); a late reply is then ignored.
 * `origin_refused` is decided page-side before anything is sent, when the page origin is not in the allowed list.
 */
import { getCashTreesNativeNfcHost } from '../utils/cashTreesNativeNfc'
import { eventPayloadOf, NATIVE_EVENT_NAMES, postChatModuleCommand } from './nativeKeyState'
import { publishNativePwaLog } from '@/utils/cashTreesNativePwaLog'

type Loose = Record<string, unknown>

export type ShellRecordTransportKind = 'window' | 'chat' | 'not_supported' | 'none'

/** One answer: a payload (an ack envelope), or a transport outcome that is not a payload. */
export type ShellRecordAnswer =
	| { kind: 'payload'; payload: Loose }
	| { kind: 'timeout' }
	| { kind: 'origin_refused' }
	| { kind: 'not_supported' }
	| { kind: 'none' }
	| { kind: 'unavailable' }

/**4: a single request times out after this long. */
export const SHELL_RECORD_REPLY_TIMEOUT_MS = 10_000
/**4: the Android origin of the shell's assets. */
const ANDROID_ORIGIN = 'https://appassets.androidplatform.net'

/** Test seam: the page origin the origin check reads (null: the real `window.location.origin`). */
let pageOriginOverride: string | null = null
export function setPageOriginForTest(origin: string | null): void {
	pageOriginOverride = origin
}

function pageOrigin(): string {
	if (pageOriginOverride !== null) return pageOriginOverride
	return typeof window !== 'undefined' && window.location ? window.location.origin : ''
}

const isPlain = (v: unknown): v is Loose => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Injected: the platform put `window.BeamioShellRecord` in place, even when its value is null or unusable (no fallback then). */
function injectionPresent(): boolean {
	return typeof window !== 'undefined' && 'BeamioShellRecord' in window
}

function injectedObject(): unknown {
	return typeof window === 'undefined' ? undefined : (window as unknown as { BeamioShellRecord?: unknown }).BeamioShellRecord
}

type InjectedHost = { postMessage?: unknown; onmessage?: unknown; allowedOrigins?: unknown }

function iosChatChannelPresent(): boolean {
	const ios = (window as unknown as { CashTreesIOS?: { chatModuleCommand?: unknown } }).CashTreesIOS
	return !!ios && typeof ios === 'object' && typeof ios.chatModuleCommand === 'function'
}

/** The transport the page uses now. */
export function shellRecordTransportKind(): ShellRecordTransportKind {
	if (injectionPresent()) return 'window'
	const platform = getCashTreesNativeNfcHost()
	if (platform === 'ios' && iosChatChannelPresent()) return 'chat'
	if (platform === 'android') return 'not_supported'
	return 'none'
}

/**
 * The origins the page may send from. Android: the fixed shell origin. iOS: the list the shell gives with its injection;
 * when the list is not given the page does not refuse (the native boundary decides). null: no page-side check.
 */
function allowedOriginsFor(host: InjectedHost | null): string[] | null {
	const platform = getCashTreesNativeNfcHost()
	if (platform === 'android') return [ANDROID_ORIGIN]
	const fromHost = host && Array.isArray(host.allowedOrigins) ? (host.allowedOrigins as unknown[]).filter((o): o is string => typeof o === 'string') : null
	if (fromHost) return fromHost
	const ios = (window as unknown as { CashTreesIOS?: { allowedOrigins?: unknown } }).CashTreesIOS
	if (ios && Array.isArray(ios.allowedOrigins)) return (ios.allowedOrigins as unknown[]).filter((o): o is string => typeof o === 'string')
	return null
}

const originAllowed = (list: string[] | null): boolean => list === null || list.includes(pageOrigin())

// ---- replies --------------------------------------------------------------------------------------------------------------

/**
 * A reply is well formed when it is an ack with a result (ok) or with a string error (not ok). `bareOk` (pwaWalletSync only, r94):
 * an ok ack with no result object is well formed too; the spec gives the reply as a code, not a result.
 */
function wellFormedAck(data: Loose, bareOk = false): boolean {
	if (data.type !== 'ack') return false
	if (data.ok === true) return bareOk || isPlain(data.result)
	if (data.ok === false) return typeof data.error === 'string'
	return false
}

function parseReply(data: unknown): Loose | null {
	if (typeof data === 'string') {
		try {
			const v: unknown = JSON.parse(data)
			return isPlain(v) ? v : null
		} catch {
			return null
		}
	}
	return isPlain(data) ? data : null
}

/** One open request: the reply that answers it (the first valid one). */
type OpenRequest = { deliver: (payload: Loose) => void; bareOk: boolean }

/** Open requests on the injected object, by reqId. A request whose reqId is open is never sent again. */
const hostOpen = new Map<unknown, OpenRequest>()
let listenedHost: InjectedHost | null = null

/** reqIds whose answer was taken (decided), bounded: a later reply for one of them is dropped with cause=decided ( ②). */
const hostConcluded: unknown[] = []

function ensureHostListener(host: InjectedHost): void {
	if (listenedHost === host) return
	listenedHost = host
	host.onmessage = (ev: unknown) => {
		const data = parseReply((ev as { data?: unknown } | null)?.data ?? ev)
		if (!data) return
		const open = hostOpen.get(data.reqId)
		if (!open) {
			// an unknown reqId, a late or a duplicate reply: dropped, with a log ( ②): cause=decided or reqid_mismatch
			const cause = hostConcluded.includes(data.reqId) ? 'decided' : 'reqid_mismatch'
			publishNativePwaLog('warn', `[start] late_result_discarded reqId=${data.reqId} cause=${cause}`)
			return
		}
		if (!wellFormedAck(data, open.bareOk)) return // malformed: the request keeps waiting
		open.deliver(data)
	}
}

function sendViaHost(host: InjectedHost, cmd: Loose, timeoutMs: number, bareOk = false): Promise<ShellRecordAnswer> {
	const reqId = cmd.reqId
	if (hostOpen.has(reqId)) return Promise.resolve({ kind: 'unavailable' })
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (answer: ShellRecordAnswer) => {
			if (hostOpen.get(reqId) === entry) hostOpen.delete(reqId)
			if (timer !== undefined) clearTimeout(timer)
			if (answer.kind === 'payload') {
				hostConcluded.push(reqId)
				if (hostConcluded.length > 64) hostConcluded.shift()
			}
			resolve(answer)
		}
		const entry: OpenRequest = { deliver: (payload) => finish({ kind: 'payload', payload }), bareOk }
		hostOpen.set(reqId, entry)
		ensureHostListener(host)
		timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
		try {
			;(host.postMessage as (message: string) => void)(JSON.stringify(cmd))
		} catch {
			finish({ kind: 'unavailable' })
		}
	})
}

// ---- the iOS chat module channel ---------------------------------------------------------------------------------------

const chatOpen = new Map<unknown, OpenRequest>()
let chatListening = false

function chatListener(ev: Event): void {
	const payload = eventPayloadOf(ev)
	if (!payload) return
	const open = chatOpen.get(payload.reqId)
	if (!open) return
	if (!wellFormedAck(payload, open.bareOk)) return
	open.deliver(payload)
}

function sendViaChat(cmd: Loose, timeoutMs: number, bareOk = false): Promise<ShellRecordAnswer> {
	const reqId = cmd.reqId
	if (chatOpen.has(reqId)) return Promise.resolve({ kind: 'unavailable' })
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (answer: ShellRecordAnswer) => {
			if (chatOpen.get(reqId) === entry) chatOpen.delete(reqId)
			if (timer !== undefined) clearTimeout(timer)
			if (chatOpen.size === 0 && chatListening) {
				for (const name of NATIVE_EVENT_NAMES) window.removeEventListener(name, chatListener)
				chatListening = false
			}
			resolve(answer)
		}
		const entry: OpenRequest = { deliver: (payload) => finish({ kind: 'payload', payload }), bareOk }
		chatOpen.set(reqId, entry)
		if (!chatListening) {
			for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, chatListener)
			chatListening = true
		}
		timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
		let sent = false
		try {
			sent = postChatModuleCommand(cmd)
		} catch {
			sent = false
		}
		if (!sent) finish({ kind: 'unavailable' })
	})
}

/**
 * Sends `walletEoaAddress` or `walletCredential` : the window channel only. These commands never fall back to the chat
 * channel; without the window channel the answer is `not_supported` (Android) or `none` (browser).
 */
export function sendWindowOnlyCommand(cmd: Loose, timeoutMs: number = SHELL_RECORD_REPLY_TIMEOUT_MS): Promise<ShellRecordAnswer> {
	// review (2026-11-17): the window-only commands are for the trusted top frame; a child frame sends nothing
	if (!inTrustedTopFrame()) return Promise.resolve({ kind: 'unavailable' })
	const kind = shellRecordTransportKind()
	if (kind !== 'window') return Promise.resolve({ kind: kind === 'none' ? 'none' : 'not_supported' })
	return sendShellRecordCommand(cmd, timeoutMs)
}

/**
 * Sends one shell record command (`shellRecordRead` or `shellRecordWrite`, with its reqId) over the chosen transport. Never falls
 * back: an injected object that cannot be used answers `unavailable`; a refused origin answers `origin_refused` without sending.
 */
export function sendShellRecordCommand(cmd: Loose, timeoutMs: number = SHELL_RECORD_REPLY_TIMEOUT_MS): Promise<ShellRecordAnswer> {
	return sendOverTransport(cmd, timeoutMs, false)
}

/**
 * r94 (spec §十一): `pwaWalletSync` and `nativeMnemonicPreread` over the same transports. Every ok reply carries a result (the spec's
 * envelope); the bare-ok allowance is not used. The same origin check and reqId matching apply; nothing falls back.
 */
export function sendShellWalletSyncCommand(cmd: Loose, timeoutMs: number = SHELL_RECORD_REPLY_TIMEOUT_MS): Promise<ShellRecordAnswer> {
	// review (2026-11-17): pwaWalletSync and nativeMnemonicPreread are for the trusted top frame only (a page-side gate; the shell has its own)
	if (!inTrustedTopFrame()) return Promise.resolve({ kind: 'unavailable' })
	return sendOverTransport(cmd, timeoutMs, false)
}

/** The page is the top frame of its window (a child frame, e.g. an embedded page, is not trusted for these commands). */
function inTrustedTopFrame(): boolean {
	try {
		return typeof window !== 'undefined' && window.top === window.self
	} catch {
		return false
	}
}

function sendOverTransport(cmd: Loose, timeoutMs: number, bareOk: boolean): Promise<ShellRecordAnswer> {
	const kind = shellRecordTransportKind()
	if (kind === 'window') {
		const value = injectedObject()
		const host = value !== null && typeof value === 'object' ? (value as InjectedHost) : null
		if (!originAllowed(allowedOriginsFor(host))) return Promise.resolve({ kind: 'origin_refused' })
		if (host === null || typeof host.postMessage !== 'function') return Promise.resolve({ kind: 'unavailable' })
		return sendViaHost(host, cmd, timeoutMs, bareOk)
	}
	if (kind === 'chat') {
		if (!originAllowed(allowedOriginsFor(null))) return Promise.resolve({ kind: 'origin_refused' })
		return sendViaChat(cmd, timeoutMs, bareOk)
	}
	return Promise.resolve({ kind: kind === 'not_supported' ? 'not_supported' : 'none' })
}
