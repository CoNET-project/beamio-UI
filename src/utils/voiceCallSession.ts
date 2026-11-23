import { verifyMessage } from 'ethers'
import { cachedWallet } from './dialWalletCache'
import {
	ensureBeamioTagProfiles,
	lookupBeamioTagProfile,
	searchBeamioTagRemote,
} from '@/services/beamioTagWorkerBridge'
import { dispatchNativeSystemCallAction } from './cashTreesNativeNfc'
import { publishNativePwaLog } from './cashTreesNativePwaLog'
import { ringAskMode } from './incomingRangTracking'
import { voiceOfferAdmissibilityRefusal, voiceOfferDedup, voiceOfferWithinLateWindow } from './voiceOfferDedup'
import { isShellContext } from '@/services/shellContext'

/**
 * Ring window for every call, all platforms (2026-11-02): 60 s from the offer's
 * `createdAt`. iOS ends an unanswered CallKit call after about 60 s on its own,
 * so a longer window cannot hold. The caller decides: at this mark it sends
 * `voice_call_timeout_v1` and records `timed_out`. A callee shell closes 60 s
 * after its own ring started (later than the dial) as a backup, and also sends
 * the timeout. Must match `INCOMING_RING_TIMEOUT_MS` (Android) and
 * `offerRingWindowOver` (iOS).
 */
export const INCOMING_CALL_RING_TIMEOUT_MS = 60_000

/**
 * Wake receipt window. The callee's device sends `voice_call_ringing_v1` as soon
 * as it rings; without one in this time the dialer says the callee's phone may
 * be blocking the wake-up push (Samsung deep sleep, force stop). The call keeps
 * ringing until the normal timeout.
 */
export const VOICE_PEER_WAKE_TIMEOUT_MS = 8_000

/**
 * No wake receipt after five ringback rings: the callee's phone never got the
 * call (force stopped, switched off, push blocked). The dialer says
 * "Unreachable", sends the cancel and records the call as `unreachable`, so a
 * late push cannot ring the callee for a call that is over. A receipt that
 * comes later is ignored.
 *
 * Five rings of the 1 s on / 4 s off ringback (browser, iOS) = 25 s from the
 * offer's timestamp. Android counts five rings of its SIM-country tone and keeps
 * the result between 20 and 30 s (`BeamioNativeVoiceSignaling.peerUnreachableMs`).
 */
export const VOICE_PEER_UNREACHABLE_MS = 25_000

/** How long the dial screen shows "Unreachable" before it closes. */
export const VOICE_PEER_UNREACHABLE_NOTICE_MS = 2_000

/**
 * Dialer wake state: `restricted` = no receipt after 8 s (call keeps ringing),
 * `unreachable` = no receipt after five rings (call is over).
 */
export type VoicePeerWake = 'waiting' | 'ringing' | 'restricted' | 'unreachable'

/** A receipt shows "Ringing", unless the call already ended as unreachable. */
export function voicePeerWakeAfterReceipt(current: VoicePeerWake): VoicePeerWake {
	return current === 'unreachable' ? current : 'ringing'
}

/** The 8 s or five-ring timer fired. A receipt that already came always wins. */
export function voicePeerWakeAfterTimer(
	current: VoicePeerWake,
	timer: 'restricted' | 'unreachable',
): VoicePeerWake {
	if (current === 'ringing' || current === 'unreachable') return current
	if (timer === 'unreachable') return 'unreachable'
	return current === 'waiting' ? 'restricted' : current
}

/**
 * Wake receipts already received (callId / sessionId → time), so a dial screen
 * that subscribes after the receipt arrived still shows "Ringing".
 */
const peerRingingSeen = new Map<string, number>()
const PEER_RINGING_KEEP_MS = 10 * 60_000

export function noteVoicePeerRinging(callId?: string, sessionId?: string, now = Date.now()): void {
	peerRingingSeen.forEach((at, key) => {
		if (now - at > PEER_RINGING_KEEP_MS) peerRingingSeen.delete(key)
	})
	const c = String(callId || '').trim()
	const s = String(sessionId || '').trim()
	if (c) peerRingingSeen.set(`c:${c}`, now)
	if (s) peerRingingSeen.set(`s:${s}`, now)
}

/** Does this receipt (event detail) belong to our dial? */
export function voicePeerRingingMatches(
	detail: { callId?: string; sessionId?: string } | null | undefined,
	offer: { callId?: string; sessionId?: string } | null | undefined,
): boolean {
	const callId = String(detail?.callId || '').trim()
	const sessionId = String(detail?.sessionId || '').trim()
	return Boolean(
		(callId && callId === String(offer?.callId || '').trim()) ||
			(sessionId && sessionId === String(offer?.sessionId || '').trim()),
	)
}

export function wasVoicePeerRinging(
	offer: { callId?: string; sessionId?: string } | null | undefined,
	now = Date.now(),
): boolean {
	const fresh = (key: string) => {
		const at = peerRingingSeen.get(key)
		return at !== undefined && now - at <= PEER_RINGING_KEEP_MS
	}
	const c = String(offer?.callId || '').trim()
	const s = String(offer?.sessionId || '').trim()
	return Boolean((c && fresh(`c:${c}`)) || (s && fresh(`s:${s}`)))
}

export type VoiceCallSignal = {
	type:
		| 'voice_call_offer_v1'
		| 'voice_call_accept_v1'
		| 'voice_call_reject_v1'
		| 'voice_call_timeout_v1'
		| 'voice_end_v1'
		| 'voice_call_ringing_v1'
	callId: string
	sessionId: string
	from: string
	to: string
	createdAt: number
	expiresAt: number
	timestamp: number
	codec?: string
	reason?: string
	/** EIP-191 signature by the caller over {@link voiceCallOfferSignText}. Not an identity field. */
	callerSignature?: string
	/** Claim inside the encrypted offer. Display only after comparing it with the signature. */
	callerTag?: string
	/** Voice protocol v3 (paid channels created by the callee). Offers and accepts carry `3`. */
	proto?: number
	/** v3 offer: base64 of the caller's user-PGP public key (the callee answers to it). */
	callerPgp?: string
	/** v3 offer: base64 of the caller's mailbox route public key. */
	callerRoute?: string
	/** v3 accept: the four channels (memory only; never logged). */
	ch?: unknown
}

export const VOICE_CALL_IDENTITY_WARNING = 'Does not match the signing key'

export function claimedVoiceCallerTag(signal: { callerTag?: string } | null | undefined): string {
	return formatLookedUpBeamioTag(signal?.callerTag)
}

export function claimedVoiceCallerAddress(signal: { from?: string } | null | undefined): string {
	const from = String(signal?.from || '').trim()
	return /^0x[0-9a-fA-F]{40}$/.test(from) ? from : ''
}

/** True when the offer's claimed tag or wallet is not the key that signed it. */
export function voiceCallClaimMismatchesKey(
	signal: { callerTag?: string; from?: string } | null | undefined,
	recoveredAddress: string | null,
	lookedUpTag: string,
	lookupFinished = false,
): boolean {
	const claimedTag = claimedVoiceCallerTag(signal)
	const claimedAddress = claimedVoiceCallerAddress(signal).toLowerCase()
	const recovered = String(recoveredAddress || '').toLowerCase()
	if (!recovered) return Boolean(claimedTag || claimedAddress)
	if (claimedAddress && claimedAddress !== recovered) return true
	if (!claimedTag) return false
	if (!lookedUpTag) return lookupFinished
	return claimedTag.toLowerCase() !== lookedUpTag.toLowerCase()
}

/** `@BeamioTag` looked up for a signature-recovered address. Offer payload text is ignored. */
export function formatLookedUpBeamioTag(username?: string | null): string {
	const raw = String(username || '').trim().replace(/^@/, '')
	if (!/^[A-Za-z0-9_]{1,32}$/.test(raw) || /^[0-9a-fA-F]{16,32}$/.test(raw)) return ''
	return `@${raw}`
}

/** Canonical text signed by the caller. Identity fields (`from`, tag) are excluded. */
export function voiceCallOfferSignText(signal: Pick<
	VoiceCallSignal,
	'callId' | 'sessionId' | 'to' | 'createdAt' | 'expiresAt' | 'timestamp' | 'codec' | 'callerPgp' | 'callerRoute'
>): string {
	// Voice protocol v3 only: no channel material in the offer; the callee
	// creates the channels on Answer. Older offers do not verify.
	return [
		'CoNET voice_call_offer_v3',
		`callId:${signal.callId}`,
		`sessionId:${signal.sessionId}`,
		`to:${String(signal.to || '').toLowerCase()}`,
		`createdAt:${signal.createdAt}`,
		`expiresAt:${signal.expiresAt}`,
		`timestamp:${signal.timestamp}`,
		`codec:${signal.codec || ''}`,
		`callerPgp:${signal.callerPgp || ''}`,
		`callerRoute:${signal.callerRoute || ''}`,
	].join('\n')
}

export async function signVoiceCallOffer(signal: VoiceCallSignal, privateKey: string): Promise<VoiceCallSignal> {
	const callerSignature = await cachedWallet(privateKey).signMessage(voiceCallOfferSignText(signal))
	return { ...signal, callerSignature }
}

/** Recover the caller EOA from the offer signature. Returns null when the proof is missing or invalid. */
export function recoverVoiceCallOfferSigner(signal: VoiceCallSignal | null | undefined): string | null {
	if (!signal || signal.type !== 'voice_call_offer_v1' || Number(signal.proto) !== 3 || !signal.callerSignature) return null
	try {
		const recovered = verifyMessage(voiceCallOfferSignText(signal), signal.callerSignature)
		return /^0x[0-9a-fA-F]{40}$/.test(recovered) ? recovered.toLowerCase() : null
	} catch {
		return null
	}
}

/** Unwrap the nested Chat envelope used by gossip before inspecting a call signal. */
export function parseVoiceCallSignal(raw: unknown): VoiceCallSignal | null {
	let value: unknown = raw
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value)
			} catch {
				return null
			}
		}
		if (!value || typeof value !== 'object') return null
		const candidate = value as Partial<VoiceCallSignal> & { text?: unknown }
		if (
			(candidate.type === 'voice_call_offer_v1'
				|| candidate.type === 'voice_call_accept_v1'
				|| candidate.type === 'voice_call_reject_v1'
				|| candidate.type === 'voice_call_timeout_v1'
				|| candidate.type === 'voice_end_v1'
				|| candidate.type === 'voice_call_ringing_v1')
			&& typeof candidate.callId === 'string'
			&& typeof candidate.sessionId === 'string'
		) {
			return candidate as VoiceCallSignal
		}
		if (typeof candidate.text !== 'string') return null
		value = candidate.text
	}
	return null
}

const VOICE_CALL_END_TYPES: ReadonlySet<string> = new Set([
	'voice_end_v1',
	'voice_call_reject_v1',
	'voice_call_timeout_v1',
])

/**
 * callIds and sessionIds of calls that end (hangup, decline, timeout) somewhere
 * in one inbound batch. A cold start hands the whole native inbox to the page
 * at once, so an offer and its end can arrive together: that offer must not be
 * reported to the shell again. Only lines with a valid chat signature count
 * (`signerOf` returns the recovered signer, or nothing).
 */
export function voiceCallHandlesEndedInBatch(
	lines: readonly string[],
	// Kept for the call sites; the signer is no longer taken from it (v54 §61): only a verified envelope counts.
	_signerOf?: (text: string, signature: string) => string | null | undefined,
): Set<string> {
	const ended = new Set<string>()
	for (const raw of lines) {
		try {
			const signal = verifiedVoiceSignalFromLine(raw)
			if (!signal || !VOICE_CALL_END_TYPES.has(signal.type)) continue
			if (signal.callId.trim()) ended.add(signal.callId.trim())
			if (signal.sessionId.trim()) ended.add(signal.sessionId.trim())
		} catch {
			/* not a chat line */
		}
	}
	return ended
}

export function isVoiceCallProtocolMessage(raw: unknown): boolean {
	let value: unknown = raw
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value)
			} catch {
				return false
			}
		}
		if (!value || typeof value !== 'object') return false
		const candidate = value as { type?: unknown; text?: unknown }
		if (typeof candidate.type === 'string' && candidate.type.startsWith('voice_')) return true
		if (typeof candidate.text !== 'string') return false
		value = candidate.text
	}
	return false
}

const reportedIncomingVoiceCallIds = new Set<string>()
const incomingVoiceOffersByHandle = new Map<string, VoiceCallSignal>()
const terminalVoiceCallHandles = new Set<string>()
const TERMINAL_VOICE_CALL_STORAGE_KEY = 'beamio:voice-call-terminal-handles:v1'

function voiceCallHandleKey(callId: unknown, sessionId: unknown): string {
	const call = String(callId || '').trim()
	const session = String(sessionId || '').trim()
	return call && session ? `${call}:${session}` : ''
}

function loadTerminalVoiceCallHandles(): void {
	if (terminalVoiceCallHandles.size > 0 || typeof window === 'undefined') return
	try {
		const raw = window.localStorage.getItem(TERMINAL_VOICE_CALL_STORAGE_KEY)
		const values = raw ? JSON.parse(raw) : []
		if (Array.isArray(values)) {
			values
				.filter((value): value is string => typeof value === 'string' && value.includes(':'))
				.slice(-200)
				.forEach(value => terminalVoiceCallHandles.add(value))
		}
	} catch {
		/* local storage is best effort; in-memory suppression still applies */
	}
}

/** Persist a terminal state so replaying an old Chat line cannot ring again. */
export function markVoiceCallTerminal(callId: string, sessionId: string): void {
	const key = voiceCallHandleKey(callId, sessionId)
	if (!key) return
	loadTerminalVoiceCallHandles()
	terminalVoiceCallHandles.add(key)
	if (typeof window === 'undefined') return
	try {
		window.localStorage.setItem(
			TERMINAL_VOICE_CALL_STORAGE_KEY,
			JSON.stringify(Array.from(terminalVoiceCallHandles).slice(-200)),
		)
	} catch {
		/* local storage is best effort */
	}
}

export function isVoiceCallTerminal(signal: { callId?: unknown; sessionId?: unknown } | null | undefined): boolean {
	if (!signal) return false
	loadTerminalVoiceCallHandles()
	const key = voiceCallHandleKey(signal.callId, signal.sessionId)
	return Boolean(key && terminalVoiceCallHandles.has(key))
}

/** Keep the decrypted offer so a later native Decline can reject the caller. */
export function rememberIncomingVoiceOffer(signal: VoiceCallSignal | null | undefined): void {
	if (!signal || signal.type !== 'voice_call_offer_v1') return
	if (signal.callId) incomingVoiceOffersByHandle.set(signal.callId, signal)
	if (signal.sessionId) incomingVoiceOffersByHandle.set(signal.sessionId, signal)
}

export function lookupIncomingVoiceOffer(callId: string, sessionId: string): VoiceCallSignal | null {
	return incomingVoiceOffersByHandle.get(callId) || incomingVoiceOffersByHandle.get(sessionId) || null
}

/**
 * The remembered offer only when BOTH handles match. The handles are looked up one by one, so a different call that shares one
 * handle (same callId, other sessionId, or the reverse) must never be taken for this call.
 */
export function exactIncomingVoiceOffer(callId: string, sessionId: string): VoiceCallSignal | null {
	const signal = lookupIncomingVoiceOffer(callId, sessionId)
	if (!signal) return null
	return sameCallId(signal.callId, callId) && sameCallId(signal.sessionId, sessionId) ? signal : null
}

export function forgetIncomingVoiceOffer(callId: string, sessionId: string): void {
	const signal = exactIncomingVoiceOffer(callId, sessionId)
	if (!signal) return
	incomingVoiceOffersByHandle.delete(signal.callId)
	incomingVoiceOffersByHandle.delete(signal.sessionId)
}

const nativeIncomingVoiceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Caller hung up. Stop any pending native banner retry, then ask this app's
 * own shell to remove the CallStyle card. The shell is not exported, so an
 * outside Decline broadcast cannot do this.
 */
export function dismissNativeIncomingVoiceCall(callId: string, sessionId: string): void {
	// Only this call's own handles: the shell card is ended for exactly this (callId, sessionId), never for another call.
	const nativeCallId = String(callId || '').trim()
	const nativeSessionId = String(sessionId || '').trim()
	const keys = new Set<string>()
	if (nativeCallId && nativeSessionId) keys.add(`${nativeCallId}:${nativeSessionId}`)
	keys.forEach((key) => {
		const timer = nativeIncomingVoiceRetryTimers.get(key)
		if (timer !== undefined) clearTimeout(timer)
		nativeIncomingVoiceRetryTimers.delete(key)
	})
	forgetIncomingVoiceOffer(nativeCallId, nativeSessionId)
	if (!nativeCallId && !nativeSessionId) return
	dispatchNativeSystemCallAction('endSystemCall', {
		callId: nativeCallId || nativeSessionId,
		sessionId: nativeSessionId,
	})
}

/**
 * Dismiss for an UNANSWERED ring that is ended locally: a late tag lookup that contradicts the declared tag (v45 §50), or the
 * caller hung up before it was answered (v50 §56). Sends the local-only shell action dismissIncomingSystemCall {callId, sessionId}
 * (2026-11-20: the shells implement it; no uplink, no signature, no answer). Never endSystemCall (it uplinks voice_end_v1).
 * It also stops this call's retry timers and forgets the offer exactly (no other call with a shared handle is touched).
 */
export function dismissRevokedIncomingCall(callId: string, sessionId: string): void {
	const nativeCallId = String(callId || '').trim()
	const nativeSessionId = String(sessionId || '').trim()
	if (nativeCallId && nativeSessionId) {
		const key = `${nativeCallId}:${nativeSessionId}`
		const timer = nativeIncomingVoiceRetryTimers.get(key)
		if (timer !== undefined) clearTimeout(timer)
		nativeIncomingVoiceRetryTimers.delete(key)
	}
	forgetIncomingVoiceOffer(nativeCallId, nativeSessionId)
	if (!nativeCallId || !nativeSessionId) return
	dispatchNativeSystemCallAction('dismissIncomingSystemCall', { callId: nativeCallId, sessionId: nativeSessionId })
}

/**
 * A ring revoked by a late tag lookup that contradicts the declared tag: stop the ring and the card, forget the
 * offer, mark it terminal (a re-delivery is then not ringing), clear the layer, record the call as declined. Returns true when
 * revoked. An empty or matching lookup revokes nothing (查不到标签不触发). Pure: every effect is an injected dependency.
 */
export function revokeRingForLateTag(
	signal: VoiceCallSignal,
	lookedUpTag: string,
	deps: {
		dismissNative: (callId: string, sessionId: string) => void
		forget: (callId: string, sessionId: string) => void
		markTerminal: (callId: string, sessionId: string) => void
		clearLayer: (callId: string, sessionId: string) => void
		recordDeclined: (callId: string, sessionId: string) => void
	},
): boolean {
	const declared = claimedVoiceCallerTag(signal)
	if (!declared || !lookedUpTag || declared.toLowerCase() === lookedUpTag.toLowerCase()) return false
	deps.dismissNative(signal.callId, signal.sessionId)
	deps.forget(signal.callId, signal.sessionId)
	deps.markTerminal(signal.callId, signal.sessionId)
	deps.clearLayer(signal.callId, signal.sessionId)
	deps.recordDeclined(signal.callId, signal.sessionId)
	return true
}

/** Accept both browser millisecond timestamps and mailbox/FCM unix-second timestamps. */
export function normalizeVoiceTimestampMs(value: unknown): number {
	const numeric = Number(value)
	if (!Number.isFinite(numeric) || numeric <= 0) return 0
	return numeric < 100_000_000_000 ? numeric * 1000 : numeric
}

/** Accept both millisecond and Unix-second expiry values from mailbox/FCM paths. */
export function isVoiceCallOfferActive(signal: {
	expiresAt?: unknown
	callId?: unknown
	sessionId?: unknown
} | null | undefined): boolean {
	if (isVoiceCallTerminal(signal)) return false
	const expiresAtMs = normalizeVoiceTimestampMs(signal?.expiresAt)
	return expiresAtMs > Date.now()
}

/**
 * An offer that can still be ringing: active, and created within the ring
 * timeout. `expiresAt` covers the whole call duration, so an unanswered offer
 * older than the ring window (declined on another surface, missed) must not
 * be reported to the native shell again when a chat page re-reads history.
 */
export function isVoiceCallOfferRinging(signal: {
	expiresAt?: unknown
	createdAt?: unknown
	timestamp?: unknown
	callId?: unknown
	sessionId?: unknown
} | null | undefined): boolean {
	if (!isVoiceCallOfferActive(signal)) return false
	// Only createdAt is the issue time (v20 §22 / v21 §23): timestamp is not a verification input.
	const createdMs = normalizeVoiceTimestampMs(signal?.createdAt)
	// No issue time: not an admissible offer (v20 §22). Never ringing without it.
	if (!createdMs) return false
	return Date.now() - createdMs <= INCOMING_CALL_RING_TIMEOUT_MS + 15_000
}

export function claimIncomingVoiceCallReport(callId: string, sessionId: string): boolean {
	const key = `${callId.trim()}:${sessionId.trim()}`
	if (!callId.trim() || !sessionId.trim() || reportedIncomingVoiceCallIds.has(key)) return false
	reportedIncomingVoiceCallIds.add(key)
	return true
}

export function hasReportedIncomingVoiceCall(callId: string, sessionId: string): boolean {
	return reportedIncomingVoiceCallIds.has(`${callId.trim()}:${sessionId.trim()}`)
}

/** Last identity reported to the native shell per offer (`callId:sessionId`). */
const nativeIncomingReports = new Map<string, string>()

/**
 * Report an incoming offer to the native shell once. One offer reaches several
 * page paths (gossip line, chat ingest, chat page, tag lookup), and each used
 * to call `reportIncomingSystemCall`: Android then opened one Telecom call per
 * report and only one was ever disconnected, so the others stayed RINGING and
 * blocked the next dial. A repeat with the same identity is dropped; a real
 * update (address → @tag, identity warning) still goes through. Returns true
 * when the shell has this report (sent now or earlier).
 */
export function reportNativeIncomingSystemCall(payload: Record<string, unknown>): boolean {
	const callId = String(payload.callId || '').trim()
	const sessionId = String(payload.sessionId || '').trim()
	const key = `${callId}:${sessionId}`
	const displayName = String(payload.displayName || '')
	const peer = String(payload.peerAddress || '').toLowerCase()
	const signature = JSON.stringify([
		displayName,
		peer,
		payload.claimedTag || '',
		payload.claimedAddress || '',
		payload.identityWarning || '',
	])
	const previous = nativeIncomingReports.get(key)
	if (previous !== undefined) {
		const [prevName, prevPeer] = JSON.parse(previous) as [string, string]
		// Same identity, or a fallback title after the @tag was already shown.
		const downgrade = prevName.startsWith('@') && displayName === 'Beamio' && prevPeer === peer
		if (previous === signature || downgrade) {
			publishNativePwaLog('info', '[voice] native report repeat skipped')
			return true
		}
	}
	const delivered = dispatchNativeSystemCallAction('reportIncomingSystemCall', payload)
	if (delivered && callId && sessionId) {
		nativeIncomingReports.set(key, signature)
		if (nativeIncomingReports.size > 50) {
			const oldest = nativeIncomingReports.keys().next().value
			if (oldest !== undefined) nativeIncomingReports.delete(oldest)
		}
	}
	return delivered
}

/**
 * The shell answers or declines to the caller's mailbox: the payload carries
 * the caller's user-PGP and mailbox route keys from the signed v3 offer.
 */
export function nativeIncomingSystemCallPayload(args: {
	callId: string
	sessionId: string
	peerAddress: string
	displayName: string
	claimedTag?: string
	claimedAddress?: string
	identityWarning?: string
	signal?: Pick<VoiceCallSignal, 'to' | 'callerPgp' | 'callerRoute'> | null
}): Record<string, unknown> {
	const to = String(args.signal?.to || '').trim()
	return {
		callId: args.callId,
		sessionId: args.sessionId,
		peerAddress: args.peerAddress,
		displayName: args.displayName,
		claimedTag: args.claimedTag || '',
		claimedAddress: args.claimedAddress || '',
		identityWarning: args.identityWarning || '',
		...(to ? { to } : {}),
		proto: 3,
		callerPgp: String(args.signal?.callerPgp || ''),
		callerRoute: String(args.signal?.callerRoute || ''),
	}
}

/**
 * Update the native incoming-call UI as soon as a decrypted offer line exists.
 * This does not claim the in-app report, so the Chat ingest path can still
 * record the call and replace the address with a looked-up BeamioTag.
 */
/**
 * Calls whose end (hangup, decline, timeout) the page has seen on the inbound
 * line path in this page session. In memory only; markVoiceCallTerminal keeps
 * the durable copy once the batch is processed.
 */
const endedVoiceCallHandles = new Set<string>()

export function noteVoiceCallsEnded(handles: Iterable<string>): void {
	for (const handle of handles) {
		const id = String(handle || '').trim()
		if (id) endedVoiceCallHandles.add(id)
	}
	while (endedVoiceCallHandles.size > 400) {
		const oldest = endedVoiceCallHandles.values().next().value
		if (oldest === undefined) break
		endedVoiceCallHandles.delete(oldest)
	}
}

const voiceCallEndSeen = (signal: { callId?: unknown; sessionId?: unknown }): boolean =>
	endedVoiceCallHandles.has(String(signal.callId || '').trim())
	|| endedVoiceCallHandles.has(String(signal.sessionId || '').trim())

/**
 * An offer older than this is a replay (cold start hands over the native inbox,
 * a reconnect drains the mailbox), not a live ring. Its end can be a few lines
 * behind it, so its report waits briefly.
 */
const VOICE_OFFER_REPLAY_AGE_MS = 15_000
const VOICE_OFFER_REPLAY_HOLD_MS = 1_000
const replayedVoiceOfferTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * The offer carried by a chat line, verified (draft-v55 §62, v54 §61.2). The outer envelope signature is required: the line must
 * be an envelope {text, signMessage, from?}; the outer signer (recovered from signMessage over text) must equal envelope.from (when
 * present) and the inner offer's from; the inner text must be the offer itself (no nested envelope). A bare offer JSON is refused.
 * Returns the inner offer, or null (silent drop).
 */
function parseJsonObject(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown
	} catch {
		return null
	}
}

/**
 * Any voice signal carried by a chat line, verified (draft-v55 §62, v54 §61): the line must be a signed chat envelope
 * {text, signMessage, from}; the outer signer (EIP-191 over text) must equal envelope.from; the inner text must be the signal itself
 * (no nested envelope); the inner from, when present, must equal the outer signer. An offer also needs its own inner signature
 * (recoverVoiceCallOfferSigner). Returns the inner signal, or null (silent drop). This is the only parser for ringing and for the
 * call signals the page acts on (end, reject, timeout, accept, ringing).
 */
export function verifiedVoiceSignalFromLine(raw: string): VoiceCallSignal | null {
	const env = parseJsonObject(raw) as { text?: unknown; signMessage?: unknown; from?: unknown } | null
	if (!env || typeof env !== 'object' || typeof env.text !== 'string' || typeof env.signMessage !== 'string') return null
	let outerSigner: string
	try {
		outerSigner = verifyMessage(env.text, env.signMessage).toLowerCase()
	} catch {
		return null
	}
	if (!/^0x[0-9a-f]{40}$/.test(outerSigner)) return null
	// envelope.from is required and must be the outer signer (v54 §61.2, v60 §67.2).
	if (typeof env.from !== 'string' || env.from.toLowerCase() !== outerSigner) return null
	const inner = parseJsonObject(env.text) as VoiceCallSignal | null
	if (!inner || typeof inner !== 'object' || typeof inner.callId !== 'string' || typeof inner.sessionId !== 'string') return null
	if (typeof inner.type !== 'string' || !inner.type.startsWith('voice_')) return null
	// Every voice signal carries its inner from, and it must be the outer signer (v68 §75). A missing from is refused silently.
	if (typeof inner.from !== 'string' || inner.from.toLowerCase() !== outerSigner) return null
	if (inner.type === 'voice_call_offer_v1') {
		// the offer's own signature is checked as well (the inner check stays; the outer one is added, not a replacement)
		if (recoverVoiceCallOfferSigner(inner) !== outerSigner) return null
	}
	return inner
}

/**
 * The call signal of a STORED chat row, read only when the row carries the `voiceVerified` marker written at ingestion (App
 * addNewMessage, after the voice gate). A row without the marker (history merge, backfill from before the gate, a cache load) is
 * display only: it never changes call state. The marker stores no key.
 */
export function storedVoiceSignal(row: { text?: string | null; voiceVerified?: boolean } | null | undefined): VoiceCallSignal | null {
	if (!row || row.voiceVerified !== true || typeof row.text !== 'string') return null
	return parseVoiceCallSignal(row.text)
}

/** The offer carried by a chat line, verified (see verifiedVoiceSignalFromLine). */
export function verifiedVoiceOfferFromLine(raw: string): VoiceCallSignal | null {
	const signal = verifiedVoiceSignalFromLine(raw)
	return signal && signal.type === 'voice_call_offer_v1' ? signal : null
}

export function applyNativeIncomingVoiceOfferFromLine(raw: string): boolean {
	// Bare JSON and any line whose outer envelope signature does not match are dropped silently (v55 §62).
	const signal = verifiedVoiceOfferFromLine(raw)
	if (!signal) {
		publishNativePwaLog(
			'info',
			`[voice] incoming line ignored chars=${raw.length} voiceOffer=${raw.includes('voice_call_offer_v1')}`,
		)
		return false
	}
	if (signal.type !== 'voice_call_offer_v1') {
		console.info(`[voice] incoming signal ignored: type=${signal.type}`)
		return false
	}
	if (typeof signal.callId !== 'string' || !signal.callId.trim() ||
		typeof signal.sessionId !== 'string' || !signal.sessionId.trim()) {
		console.warn(
			`[voice] incoming offer ignored: missing handle callId=${typeof signal.callId === 'string'} ` +
			`sessionId=${typeof signal.sessionId === 'string'}`,
		)
		return false
	}
	// Late window (draft-v37 §41): valid only while now <= the signed expiresAt, never past +300 s.
	if (!voiceOfferWithinLateWindow(signal, Date.now())) {
		console.warn(
			`[voice] incoming offer ignored: outside late window expiresAtPresent=${Boolean(signal.expiresAt)} ` +
			`normalizedMs=${normalizeVoiceTimestampMs(signal.expiresAt) > 0}`,
		)
		return false
	}
	// Already ended (stored terminal mark, or its end was seen on the line path),
	// or older than the ring window: never ring the shell for it again.
	if (!isVoiceCallOfferRinging(signal) || voiceCallEndSeen(signal)) {
		publishNativePwaLog('info', '[voice] incoming offer not reported: call already ended or past the ring window')
		return false
	}
	const callKey = `${signal.callId.trim()}:${signal.sessionId.trim()}`
	const createdMs = normalizeVoiceTimestampMs(signal.createdAt)
	if (createdMs && Date.now() - createdMs > VOICE_OFFER_REPLAY_AGE_MS) {
		if (!replayedVoiceOfferTimers.has(callKey)) {
			replayedVoiceOfferTimers.set(callKey, setTimeout(() => {
				replayedVoiceOfferTimers.delete(callKey)
				if (!isVoiceCallOfferRinging(signal) || voiceCallEndSeen(signal)) {
					publishNativePwaLog('info', '[voice] replayed offer not reported: its end followed it')
					return
				}
				reportNativeIncomingVoiceOffer(signal)
			}, VOICE_OFFER_REPLAY_HOLD_MS))
		}
		return false
	}
	return reportNativeIncomingVoiceOffer(signal)
}

/**
 * Admission of an incoming offer that is about to ring (draft-v33 §33.2 v3 verification, draft-v36 §40 dedup,
 * draft-v37 §41 late window and §41.4 `from` check). Registers the offer in the dedup table when admitted, so only the
 * path that admits it rings; every later delivery of the same (callId, sessionId) is refused as a duplicate.
 * Called only by a path that actually rings: the shell's native report, the App's ring branch, the chat page's ring.
 */
/**
 * The local @tag lookup for a signed address (the App registers it; null when none). Every admission path uses it, so a shell
 * offer that reaches admission first is checked against the same local tag as the App's ring path.
 */
let incomingOfferTagLookup: ((signerEoa: string) => string) | null = null
export function setIncomingOfferTagLookup(fn: ((signerEoa: string) => string) | null): void {
	incomingOfferTagLookup = fn
}

export function admitIncomingVoiceOffer(signal: VoiceCallSignal, now = Date.now(), lookedUpTagArg = ''): IncomingOfferAdmission {
	if (typeof signal.callId !== 'string' || !signal.callId.trim() || typeof signal.sessionId !== 'string' || !signal.sessionId.trim()) {
		return { ok: false, reason: 'handle' }
	}
	const signer = recoverVoiceCallOfferSigner(signal)
	const refusal = voiceOfferAdmissibilityRefusal(signal, signer)
	if (refusal || !signer) return { ok: false, reason: refusal ?? 'no_signer' }
	// v10 §12 / v18 §18.1: a declared @tag that differs from the tag looked up for the signed address is refused (not a warning).
	// An unknown lookup (empty lookedUpTag) cannot decide here; see the report.
	const claimed = claimedVoiceCallerTag(signal)
	const lookedUpTag = lookedUpTagArg || (incomingOfferTagLookup && signer ? incomingOfferTagLookup(signer) : '')
	if (claimed && lookedUpTag && claimed.toLowerCase() !== lookedUpTag.toLowerCase()) return { ok: false, reason: 'tag_mismatch' }
	if (!voiceOfferWithinLateWindow(signal, now)) return { ok: false, reason: 'late_window' }
	const registered = voiceOfferDedup.register(signal.callId, signal.sessionId, signer, now)
	if (!registered.ok) return { ok: false, reason: registered.reason }
	return { ok: true, callerEoa: signer }
}

export type IncomingOfferAdmission =
	| { ok: true; callerEoa: string }
	| {
			ok: false
			reason:
				| 'handle'
				| 'late_window'
				| 'no_signer'
				| 'from_missing'
				| 'from_mismatch'
				| 'no_created_at'
				| 'tag_mismatch'
				| 'duplicate'
				| 'caller_quota'
				| 'global_full'
	  }

function reportNativeIncomingVoiceOffer(signal: VoiceCallSignal): boolean {
	// The native ring exists only in the shell; a browser has no native ring to admit into.
	if (!isShellContext()) return false
	const admission = admitIncomingVoiceOffer(signal)
	if (!admission.ok) {
		publishNativePwaLog('info', `[voice] incoming offer not reported: ${admission.reason}`)
		return false
	}
	const callerEoa = admission.callerEoa
	const claimedTag = claimedVoiceCallerTag(signal)
	const mismatch = voiceCallClaimMismatchesKey(signal, callerEoa, '')
	const callKey = `${signal.callId.trim()}:${signal.sessionId.trim()}`
	// CallKit layout collapses when displayName is a short EOA capsule and a
	// later report swaps in @tag. Never send an address as CallKit title.
	const proven = callerEoa || ''
	// v10 §12 / v18 §18.1: a declared tag is not shown unless it was looked up and matches the signer. This report has no lookup,
	// so the title is 'Beamio' (the App's ring branch sets the looked-up tag).
	const displayName = 'Beamio'
	const payload = nativeIncomingSystemCallPayload({
		callId: signal.callId,
		sessionId: signal.sessionId,
		peerAddress: proven,
		displayName,
		claimedTag: mismatch ? claimedTag : '',
		claimedAddress: mismatch ? claimedVoiceCallerAddress(signal) : '',
		identityWarning: mismatch ? VOICE_CALL_IDENTITY_WARNING : '',
		signal,
	})
	console.info(
		`[voice] decrypted incoming offer callId=${Boolean(signal.callId)} ` +
			`sessionId=${Boolean(signal.sessionId)} verifiedPeer=${Boolean(proven)} ` +
			`displayName=${Boolean(displayName)}`,
	)
	const delivered = reportNativeIncomingSystemCall(payload)
	publishNativePwaLog(
		'info',
		`[voice] native report dispatch=${delivered ? 'accepted' : 'unavailable'} ` +
			`verifiedPeer=${Boolean(proven)} tagClaim=${Boolean(claimedTag)}`,
	)
	if (delivered) {
		const timer = nativeIncomingVoiceRetryTimers.get(callKey)
		if (timer !== undefined) clearTimeout(timer)
		nativeIncomingVoiceRetryTimers.delete(callKey)
	} else if (!nativeIncomingVoiceRetryTimers.has(callKey)) {
		// The PWA can decrypt the offer while the WebView bridge is being
		// recreated after an Android cold start. Retry a few times without
		// using an interval; the native side stores the payload in its pool.
		let attempt = 0
		const retry = () => {
			attempt += 1
			const ok = reportNativeIncomingSystemCall(payload)
			if (ok || attempt >= 8) {
				nativeIncomingVoiceRetryTimers.delete(callKey)
				return
			}
			const next = setTimeout(retry, Math.min(1500, 150 + attempt * 150))
			nativeIncomingVoiceRetryTimers.set(callKey, next)
		}
		const timer = setTimeout(retry, 150)
		nativeIncomingVoiceRetryTimers.set(callKey, timer)
	}
	// Glass Incoming title must be the wallet's @beamioTag. When the first
	// report only has the EOA, look up and re-report so native can refresh.
	if (proven && (!displayName || displayName === 'Beamio')) {
		void enrichNativeIncomingDisplayTag({
			callId: signal.callId,
			sessionId: signal.sessionId,
			peerAddress: proven,
			signal,
		})
	}
	console.info(
		delivered
			? `[voice] incoming offer delivered to native shell (${displayName || 'address'})`
			: `[voice] incoming offer queued for native bridge (${displayName || 'address'})`,
	)
	return delivered
}

async function enrichNativeIncomingDisplayTag(args: {
	callId: string
	sessionId: string
	peerAddress: string
	signal: VoiceCallSignal
}): Promise<void> {
	const peer = args.peerAddress.toLowerCase()
	try {
		await ensureBeamioTagProfiles([peer], { maxPerTick: 4 })
		const local = await lookupBeamioTagProfile(peer)
		let username = local?.accountName || local?.username || ''
		if (!username) {
			const res = await searchBeamioTagRemote(peer)
			const results = res?.results
			const rows = Array.isArray(results) ? results : []
			const hit = rows.find((row: { address?: string }) =>
				String(row.address || '').toLowerCase() === peer,
			) as { username?: string; accountName?: string } | undefined
			username = hit?.username || hit?.accountName || ''
		}
		const tag = formatLookedUpBeamioTag(username)
		if (!tag) return
		const nextMismatch = voiceCallClaimMismatchesKey(args.signal, peer, tag, true)
		reportNativeIncomingSystemCall(
			nativeIncomingSystemCallPayload({
				callId: args.callId,
				sessionId: args.sessionId,
				peerAddress: peer,
				displayName: tag,
				claimedTag: nextMismatch ? claimedVoiceCallerTag(args.signal) : '',
				claimedAddress: nextMismatch ? claimedVoiceCallerAddress(args.signal) : '',
				identityWarning: nextMismatch ? VOICE_CALL_IDENTITY_WARNING : '',
				signal: args.signal,
			}),
		)
		publishNativePwaLog('info', `[voice] native report tag upgrade tag=${tag}`)
	} catch {
		// Keep last native UI; native shell may still enrich via search-users.
	}
}

export const VOICE_MAX_FRAME_B64 = 12_000
export const VOICE_FRAME_TIMESTAMP_SKEW_SEC = 30
export const VOICE_CALL_MAX_DURATION_MS = 15 * 60 * 1000

export const randomVoiceId = (prefix: string): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return `${prefix}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
}

/** Mailbox `voice_listen` only accepts `[0-9a-fA-F-]{16,64}`. A `voice-` prefix is dropped and the ring push never fires. */
export const randomMailboxVoiceSessionId = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export const createVoiceSessionKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

/** Chunked — avoid `String.fromCharCode(..largeUint8Array)` stack overflows in WebView. */
const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
	const raw = atob(value)
	const out = new Uint8Array(raw.length)
	for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
	return out
}

export const voiceSessionKeyToBase64 = (key: Uint8Array): string => bytesToBase64(key)

export const voiceSessionKeyFromBase64 = (value: string): Uint8Array => {
	const key = base64ToBytes(value)
	if (key.length !== 32) throw new Error('voice_session_key_invalid')
	return key
}

const PHONE_CALL_STATUS_RANK: Record<PhoneCallRecord['status'], number> = {
	ringing: 0,
	answered: 2,
	cancelled: 3,
	declined: 3,
	failed: 3,
	missed: 3,
	timed_out: 3,
	ended: 3,
	// The most specific "not connected" outcome: a plain decline arriving after it
	// (the page's own copy, a shell's callRejected) must not hide it.
	busy: 4,
	// No ringing receipt after five rings. The cancel and the shell's call end
	// that follow are read as "cancelled" and must not hide it.
	unreachable: 4,
}

const PHONE_CALL_TERMINAL_STATUSES: ReadonlySet<PhoneCallRecord['status']> = new Set([
	'cancelled',
	'declined',
	'busy',
	'failed',
	'missed',
	'timed_out',
	'ended',
	'unreachable',
])

export const isPhoneCallTerminalStatus = (status: PhoneCallRecord['status'] | undefined): boolean =>
	Boolean(status && PHONE_CALL_TERMINAL_STATUSES.has(status))

/** Outcomes that mean "never connected". A call that was answered cannot end in one of them. */
const PHONE_CALL_UNANSWERED_STATUSES: ReadonlySet<PhoneCallRecord['status']> = new Set([
	'cancelled',
	'declined',
	'busy',
	'missed',
	'timed_out',
	'unreachable',
])

/**
 * The callee was in another call: the caller's call screen stays about this long,
 * says "On another call" and lets the busy tone (3 × 0.5 s) finish, then closes.
 * Hang-up during the hold closes it at once.
 */
export const BUSY_HOLD_MS = 3_000

/**
 * Whether the page itself ends the shell's system call (CallKit / Telecom) when
 * the call ends with `status`. Not for busy inside a native shell: its dialer
 * shows "On another call", plays the busy tone and ends the call after it.
 */
export const pageEndsSystemCall = (status: PhoneCallRecord['status'] | undefined, inNativeShell: boolean): boolean =>
	!(inNativeShell && status === 'busy')

/** Browser dialer: how long the in-page call window stays before it closes for `status`. */
export const callWindowHoldMs = (status: PhoneCallRecord['status'] | undefined, inNativeShell: boolean): number =>
	!inNativeShell && status === 'busy' ? BUSY_HOLD_MS : 0

/**
 * Calls the native shell answered (CallKit / Telecom), by callId and sessionId.
 * The shell can answer before the PWA has the offer (FCM / VoIP wake), so the
 * page never runs its own accept and the record stays "ringing". Also saved in
 * localStorage (ids and times only, 100 newest, 3 days): when the app is killed
 * during the call, the peer's later hang-up must still read "Call ended", not
 * "Call cancelled" (B2).
 */
export const NATIVE_ANSWERED_STORAGE_KEY = 'beamio.voice.nativeAnswered.v1'
const NATIVE_ANSWERED_MAX = 100
const NATIVE_ANSWERED_MAX_AGE_MS = 3 * 24 * 60 * 60_000

const nativeAnsweredStorage = (): Storage | null => {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

const loadNativeAnswered = (now = Date.now()): Map<string, number> => {
	const out = new Map<string, number>()
	try {
		const raw = nativeAnsweredStorage()?.getItem(NATIVE_ANSWERED_STORAGE_KEY)
		const rows = raw ? JSON.parse(raw) : []
		if (Array.isArray(rows)) {
			for (const row of rows) {
				if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number') continue
				if (row[0] && now - row[1] <= NATIVE_ANSWERED_MAX_AGE_MS) out.set(row[0], row[1])
			}
		}
	} catch {
		// Unreadable: start empty.
	}
	return out
}

const nativeAnsweredAt = loadNativeAnswered()

const saveNativeAnswered = (): void => {
	try {
		nativeAnsweredStorage()?.setItem(NATIVE_ANSWERED_STORAGE_KEY, JSON.stringify([...nativeAnsweredAt.entries()]))
	} catch {
		// Storage full or blocked: the in-memory copy still serves this page.
	}
}

/** Tests only: re-read the saved marks as a freshly launched page would. */
export const reloadNativeAnsweredForTests = (now = Date.now()): void => {
	nativeAnsweredAt.clear()
	for (const [id, at] of loadNativeAnswered(now)) nativeAnsweredAt.set(id, at)
}

export const noteNativeCallAnswered = (callId: string, sessionId: string, at = Date.now()): void => {
	for (const id of [idText(callId), idText(sessionId)]) {
		if (id && !nativeAnsweredAt.has(id)) nativeAnsweredAt.set(id, at)
	}
	while (nativeAnsweredAt.size > NATIVE_ANSWERED_MAX) {
		const oldest = nativeAnsweredAt.keys().next().value
		if (oldest === undefined) break
		nativeAnsweredAt.delete(oldest)
	}
	saveNativeAnswered()
	publishNativePwaLog('info', `[voice] call record answered by shell callId=${Boolean(idText(callId))} sessionId=${Boolean(idText(sessionId))}`)
}

const nativeAnsweredAtFor = (record: { callId?: string; sessionId?: string } | null | undefined): number =>
	nativeAnsweredAt.get(idText(record?.callId)) || nativeAnsweredAt.get(idText(record?.sessionId)) || 0

export const phoneCallWasAnswered = (record: PhoneCallRecord | null | undefined): boolean =>
	Boolean(record && (record.status === 'answered' || Number(record.answeredAt || 0) > 0 || nativeAnsweredAtFor(record) > 0))

/**
 * The page's fallback timers (ring window, offer expiry) may end a call as
 * `timed_out` only while nobody has answered it. Any sign of an answer stops
 * them: the page saw the accept (`answered`), the call record says answered,
 * or the shell marked the call answered (it can take the accept before the page).
 * Not "the call screen is up": that is true while it still rings.
 */
export const voiceRingTimeoutApplies = (call: {
	answered: boolean
	callId?: string
	sessionId?: string
	record?: PhoneCallRecord | null
}): boolean =>
	!call.answered
	&& !phoneCallWasAnswered(call.record)
	&& nativeAnsweredAtFor(call) === 0

/**
 * Status for a `voice_end_v1` from the peer: the peer hung up a connected call
 * ("ended"), or the caller gave up before anyone answered ("cancelled").
 */
export const phoneCallStatusForPeerHangup = (
	existing: PhoneCallRecord | null | undefined,
): PhoneCallRecord['status'] =>
	phoneCallWasAnswered(existing) || existing?.status === 'ended'
		? 'ended'
		// The shell said it never rang here: a redelivered caller's end keeps "Missed call".
		// Other unanswered rows become "cancelled", and the page then asks the shell.
		: existing?.status === 'missed' && existing.direction === 'incoming' && existing.neverRang ? 'missed' : 'cancelled'

/**
 * Keep the further-along status when two snapshots of the same call arrive out
 * of order. A later `ringing` history row must not paint the bubble back to
 * "Calling" after the ring already timed out. Equal ranks prefer the newer
 * (incoming) snapshot so decline after a bogus callEnded still shows declined.
 */
/** Chat stores some call timestamps in seconds. Compare them as milliseconds. */
export const phoneCallStampMs = (raw: unknown): number => {
	const n = Number(raw || 0)
	if (!Number.isFinite(n) || n <= 0) return 0
	return n < 1e12 ? n * 1000 : n
}

/**
 * the id text exactly as received. null and undefined give ''; nothing is trimmed, because the shell matches
 * call and session ids exactly. A whitespace-only id is a non-empty entry. Non-empty means length above 0.
 */
const idText = (value: unknown): string => (value == null ? '' : String(value))

/**
 * - /: an id as stored and sent. Only null, undefined and zero length are ''(missing). Any other value,
 * including a whitespace-only one, is kept as it is.
 */
const storedId = (value: unknown): string => idText(value)

/** - /: a row holds the ids as stored (see storedId); the other fields are kept as they are. */
const storedRow = (row: PhoneCallRecord): PhoneCallRecord => ({
	...row,
	callId: storedId(row.callId),
	sessionId: storedId(row.sessionId),
})

/**
 * two call ids match when both are non-empty (length above 0) and exactly equal. No trim, so 'c1'and 'c1'are not the
 * same call. Use this instead of === for call ids.
 */
export const sameCallId = (a: unknown, b: unknown): boolean => {
	const x = idText(a)
	return x.length > 0 && x === idText(b)
}

/** Trimmed text, for peer addresses only. Call and session ids are never trimmed (see idText). */
const nonBlank = (value: unknown): string => String(value || '').trim()

/** Match two call snapshots when either non-empty id matches exactly. */
export const phoneCallIdsOverlap = (
	a: { callId?: string; sessionId?: string } | null | undefined,
	b: { callId?: string; sessionId?: string } | null | undefined,
): boolean => {
	const aCall = idText(a?.callId)
	const aSession = idText(a?.sessionId)
	const bCall = idText(b?.callId)
	const bSession = idText(b?.sessionId)
	if (aCall && bCall && aCall === bCall) return true
	if (aSession && bSession && aSession === bSession) return true
	return false
}

/**
 * Whether an end request names a call other than the one this page is on.
 * `hint` carries the ids from a signal or a shell action; `activeIds` are all
 * the ids the page's own call goes by (offer callId and sessionId, own and peer
 * voice sessions). An end for another call, such as a replayed cancel of an
 * older incoming offer, must never close the current call (2026-11-05: a dial
 * was ended this way and the callee kept ringing).
 * False when the hint names no call (the caller means the current call) or
 * when no call is active. While a dial is still being set up it has no ids
 * yet, so any named call is another one.
 */
export const endHintTargetsOtherCall = (
	hint: { callId?: string; sessionId?: string } | null | undefined,
	activeIds: readonly (string | null | undefined)[],
	dialBeingSetUp = false,
): boolean => {
	const hintIds = [idText(hint?.callId), idText(hint?.sessionId)].filter(Boolean)
	if (!hintIds.length) return false
	const active = new Set(activeIds.map(idText).filter(Boolean))
	if (!active.size) return dialBeingSetUp
	return !hintIds.some(id => active.has(id))
}

export const findPhoneCallByIds = (
	rows: readonly PhoneCallRecord[] | null | undefined,
	ids: { callId?: string; sessionId?: string },
): PhoneCallRecord | undefined => {
	const callId = idText(ids.callId)
	const sessionId = idText(ids.sessionId)
	if (!callId && !sessionId) return undefined
	const matches = (rows || []).filter(item =>
		(callId && idText(item.callId) === callId) ||
		(sessionId && idText(item.sessionId) === sessionId))
	if (!matches.length) return undefined
	// Prefer terminal / further-along status when a buggy filter left ringing+declined duplicates.
	return matches.slice().sort((a, b) =>
		(PHONE_CALL_STATUS_RANK[b.status] ?? 0) - (PHONE_CALL_STATUS_RANK[a.status] ?? 0)
		|| Number(b.endedAt || 0) - Number(a.endedAt || 0)
		|| Number(b.createdAt || 0) - Number(a.createdAt || 0))[0]
}

/**
 * Replace any prior row that shares a non-empty callId or sessionId (exact match).
 * Never use `!== a && !== b` — that drops the wrong row when callId ≠ sessionId.
 */
export const replacePhoneCallInRows = (
	rows: readonly PhoneCallRecord[],
	merged: PhoneCallRecord,
): PhoneCallRecord[] => [
	...rows.filter(item => !phoneCallIdsOverlap(item, merged)),
	storedRow(merged),
]

/**
 * Browser only: the chat page reports whether it has a call up (dialing, ringing
 * out, or connected) and which. An offer for another call that arrives then is
 * answered "busy" without ringing (the shells do the same natively).
 */
type BrowserVoiceCallProbe = () => { live: boolean; callId?: string; sessionId?: string }
let browserVoiceCallProbe: BrowserVoiceCallProbe | null = null

export function registerBrowserVoiceCallProbe(probe: BrowserVoiceCallProbe | null): void {
	browserVoiceCallProbe = probe
}

/** This page is in a call other than `offer`'s. */
export function browserVoiceCallBusyFor(offer: { callId?: string; sessionId?: string }): boolean {
	const state = browserVoiceCallProbe?.()
	if (!state?.live) return false
	const sameCall = (!!offer.callId && offer.callId === state.callId)
		|| (!!offer.sessionId && offer.sessionId === state.sessionId)
	return !sameCall
}

const mergePhoneCallRecordInner = (
	current: PhoneCallRecord | null | undefined,
	incoming: PhoneCallRecord | null | undefined,
): PhoneCallRecord | null => {
	if (!incoming?.callId && !incoming?.sessionId) return current ?? null
	if (!current) return incoming ?? null
	const sameCall = phoneCallIdsOverlap(current, incoming)
	if (!sameCall) return incoming
	const keepCurrent = (PHONE_CALL_STATUS_RANK[current.status] ?? 0) > (PHONE_CALL_STATUS_RANK[incoming.status] ?? 0)
	let status = keepCurrent ? current.status : incoming.status
	const answered = phoneCallWasAnswered(current) || phoneCallWasAnswered(incoming)
	// Once either side saw the call answered, a later "unanswered" outcome (the
	// peer's hangup read as cancel, a stale ring timeout) means the call ended.
	if (answered && PHONE_CALL_UNANSWERED_STATUSES.has(status)) status = 'ended'
	if (answered && status === 'ringing') status = 'answered'
	const answeredAt = current.answeredAt ?? incoming.answeredAt
		?? (nativeAnsweredAtFor(current) || nativeAnsweredAtFor(incoming) || undefined)
	const endedAt = status === 'ringing'
		? undefined
		: (keepCurrent ? current.endedAt ?? incoming.endedAt : incoming.endedAt ?? current.endedAt)
	const knownDuration = keepCurrent ? current.durationMs ?? incoming.durationMs : incoming.durationMs ?? current.durationMs
	const durationMs = knownDuration ?? (status === 'ended' && answeredAt && endedAt
		? Math.max(0, phoneCallStampMs(endedAt) - phoneCallStampMs(answeredAt)) || undefined
		: undefined)
	return {
		...current,
		...incoming,
		// Never blank-overwrite stable IDs — empty bridge fields orphan history rows.
		callId: storedId(incoming.callId) || storedId(current.callId),
		sessionId: storedId(incoming.sessionId) || storedId(current.sessionId),
		status,
		direction: current.direction || incoming.direction,
		peerAddress: nonBlank(current.peerAddress) || nonBlank(incoming.peerAddress),
		createdAt: current.createdAt || incoming.createdAt,
		answeredAt,
		endedAt,
		durationMs,
	}
}

/**
 * Incoming calls the native shell closed before anyone answered them, by callId
 * and sessionId. The shell's own callEnded can reach the page before the page
 * has the call's row (cold start: it arrives first, then the native inbox
 * replays the offer), or not at all (it ended in a process that was killed).
 * The page applies these outcomes whenever it stores call rows, so a replayed
 * offer cannot leave the row "Incoming call". In memory for the page's life.
 */
const settledIncomingOutcomes = new Map<string, { status: PhoneCallRecord['status']; endedAt: number }>()

/** Record status for a shell action that ends an unanswered incoming call. */
export const incomingSettledStatusForAction = (action: unknown): PhoneCallRecord['status'] | null => {
	switch (String(action || '').trim()) {
		case 'callEnded':
			return 'cancelled'
		case 'callTimedOut':
			return 'timed_out'
		case 'callRejected':
			return 'declined'
		// The shell rejected it as busy while this device was in another call.
		case 'callBusyRejected':
			return 'busy'
		default:
			return null
	}
}

export const noteIncomingCallSettled = (
	callId: string,
	sessionId: string,
	status: PhoneCallRecord['status'],
	endedAt = Date.now(),
): void => {
	if (!PHONE_CALL_UNANSWERED_STATUSES.has(status)) return
	for (const id of [idText(callId), idText(sessionId)]) {
		if (id && !settledIncomingOutcomes.has(id)) settledIncomingOutcomes.set(id, { status, endedAt })
	}
	while (settledIncomingOutcomes.size > 400) {
		const oldest = settledIncomingOutcomes.keys().next().value
		if (oldest === undefined) break
		settledIncomingOutcomes.delete(oldest)
	}
}

/** The row with its shell outcome applied, or the same row when there is none to apply. */
export const withSettledIncomingOutcome = (record: PhoneCallRecord): PhoneCallRecord => {
	if (record.direction !== 'incoming') return record
	const outcome = settledIncomingOutcomes.get(idText(record.callId))
		|| settledIncomingOutcomes.get(idText(record.sessionId))
	if (!outcome) return record
	// A busy reject also replaces a later "missed" / "declined" guess for the
	// same call (a replayed offer past its ring window is recorded as missed).
	const applies = record.status === 'ringing'
		|| (outcome.status === 'busy' && record.status !== 'busy' && PHONE_CALL_UNANSWERED_STATUSES.has(record.status))
	if (!applies) return record
	return mergePhoneCallRecord(record, { ...record, status: outcome.status, endedAt: outcome.endedAt }) || record
}

/** Rows with every known shell outcome applied; null when nothing changed. */
export const closeSettledIncomingCalls = (
	rows: readonly PhoneCallRecord[] | null | undefined,
): PhoneCallRecord[] | null => {
	if (!rows?.length || !settledIncomingOutcomes.size) return null
	let changed = false
	const next = rows.map((row) => {
		const closed = withSettledIncomingOutcome(row)
		if (closed !== row) changed = true
		return closed
	})
	return changed ? next : null
}

/**
 * Row for an incoming offer that arrives after its ring window (the call push
 * came too late, or never): the call was missed. Null when it still rings, when
 * a terminal mark or a row already records it. A caller's end later turns it
 * "cancelled", and the shell is then asked whether it rang (it may have rung
 * while the page was not running).
 */
export const missedIncomingCallRow = (
	rows: readonly PhoneCallRecord[] | null | undefined,
	signal: VoiceCallSignal,
	peerAddress: string,
	fallbackCreatedAt: number,
): PhoneCallRecord | null => {
	if (signal.type !== 'voice_call_offer_v1') return null
	const callId = idText(signal.callId)
	const sessionId = idText(signal.sessionId)
	if (!callId || !sessionId) return null
	if (isVoiceCallOfferRinging(signal) || isVoiceCallTerminal(signal)) return null
	if (findPhoneCallByIds(rows, { callId, sessionId })) return null
	const createdAt = Number(signal.createdAt) || fallbackCreatedAt
	const createdMs = phoneCallStampMs(createdAt)
	return {
		callId,
		sessionId,
		peerAddress,
		direction: 'incoming',
		status: 'missed',
		createdAt,
		answeredAt: undefined,
		endedAt: createdMs ? createdMs + INCOMING_CALL_RING_TIMEOUT_MS : undefined,
	}
}

/**
 * Missed vs cancelled on the callee's side. A call the caller ended is
 * "Call cancelled" when it rang on this phone, "Missed call" when it never did
 * (app force stopped, deep sleep, the call push too late). Only the native
 * shell knows whether it rang, so the page asks it about each incoming
 * "cancelled" row once per page life (shells without the query, iOS and the
 * browser, keep "cancelled"). The caller's side is never changed.
 */
const INCOMING_RANG_ASK_MAX_AGE_MS = 3 * 24 * 60 * 60_000
const askedIncomingRang = new Set<string>()

export const takeIncomingCallsToAskRang = (
	rows: readonly PhoneCallRecord[] | null | undefined,
	now = Date.now(),
): Array<{ callId: string; sessionId: string; createdAt: number }> => {
	const out: Array<{ callId: string; sessionId: string; createdAt: number }> = []
	// which calls are asked depends on the shell (see incomingRangTracking.ts). Calls the shell cannot answer keep their status.
	const askMode = ringAskMode(now)
	if (askMode.mode === 'none') return out
	for (const row of rows || []) {
		if (row.direction !== 'incoming' || row.status !== 'cancelled' || phoneCallWasAnswered(row)) continue
		const callId = storedId(row.callId)
		const sessionId = storedId(row.sessionId)
		// the pair is asked as stored; an empty id is sent as empty (the shell answers rang:false for it). Nothing is
		// substituted. Both ids of zero length: nothing to ask. The de-duplication key is the exact pair.
		if (!callId && !sessionId) continue
		// the new shell answers rang:false for an empty id, which would mark a call that did ring as missed. In the new-shell
		// mode such a row is not asked and keeps its status. The old shell (one record per id) is asked as before.
		if (askMode.mode === 'since' && (!callId || !sessionId)) continue
		const key = JSON.stringify([callId, sessionId])
		if (askedIncomingRang.has(key)) continue
		const createdAt = phoneCallStampMs(row.createdAt)
		if (!createdAt || now - createdAt > INCOMING_RANG_ASK_MAX_AGE_MS) continue
		if (askMode.mode === 'since' && createdAt <= askMode.since) continue
		askedIncomingRang.add(key)
		out.push({ callId, sessionId, createdAt })
	}
	return out
}

/** Ask the shell whether these calls rang; answers come back as incomingCallOutcome events. */
export const askShellWhichIncomingCallsRang = (rows: readonly PhoneCallRecord[] | null | undefined): number => {
	const calls = takeIncomingCallsToAskRang(rows)
	if (!calls.length) return 0
	for (let i = 0; i < calls.length; i += 50) {
		dispatchNativeSystemCallAction('queryIncomingCallOutcome', { calls: calls.slice(i, i + 50) })
	}
	return calls.length
}

/** The shell says this call never rang: its "cancelled" row becomes "missed". Null when nothing changed. */
export const markIncomingCallNeverRang = (
	rows: readonly PhoneCallRecord[] | null | undefined,
	ids: { callId?: string; sessionId?: string },
): PhoneCallRecord[] | null => {
	const row = findPhoneCallByIds(rows, ids)
	if (!row || row.direction !== 'incoming' || row.status !== 'cancelled' || phoneCallWasAnswered(row)) return null
	return replacePhoneCallInRows(rows || [], { ...row, status: 'missed', neverRang: true })
}

/** The merged row, with missing ids stored as ''. */
export const mergePhoneCallRecord = (
	current: PhoneCallRecord | null | undefined,
	incoming: PhoneCallRecord | null | undefined,
): PhoneCallRecord | null => {
	const merged = mergePhoneCallRecordInner(current, incoming)
	return merged ? storedRow(merged) : merged
}

export const makeVoiceCallSignal = (
	signal: Omit<VoiceCallSignal, 'createdAt' | 'expiresAt' | 'timestamp'> & { expiresAt?: number },
): VoiceCallSignal => ({
	...signal,
	createdAt: Date.now(),
	expiresAt: signal.expiresAt ?? Date.now() + VOICE_CALL_MAX_DURATION_MS,
	timestamp: Date.now(),
})

export const encryptVoiceFrame = async (key: Uint8Array, plain: Uint8Array): Promise<string> => {
	if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('voice_session_key_invalid')
	const nonce = crypto.getRandomValues(new Uint8Array(12))
	const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
	const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plain)
	const packed = new Uint8Array(nonce.length + cipher.byteLength)
	packed.set(nonce)
	packed.set(new Uint8Array(cipher), nonce.length)
	return bytesToBase64(packed)
}

export const decryptVoiceFrame = async (key: Uint8Array, payload: string): Promise<Uint8Array> => {
	if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('voice_session_key_invalid')
	const packed = base64ToBytes(payload)
	if (packed.length < 28) throw new Error('voice_frame_too_short')
	const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: packed.slice(0, 12) },
		cryptoKey,
		packed.slice(12),
	)
	return new Uint8Array(plain)
}

export const isFreshVoiceFrame = (frame: { payload?: unknown; seq?: unknown; timestamp?: unknown }): boolean => {
	if (typeof frame.payload !== 'string' || frame.payload.length > VOICE_MAX_FRAME_B64) return false
	const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(frame.timestamp))
	return Number.isSafeInteger(frame.seq) && Number(frame.seq) >= 0 && skew <= VOICE_FRAME_TIMESTAMP_SKEW_SEC
}

/**
 * Whether an offer may detach the current live call (v70 §77): only a ringing offer that is not the current call and arrived after
 * the current call started. An older, terminal or unrelated offer never tears down a dial or another live call.
 */
export function offerReplacesLiveCall(
	offer: { sessionId?: unknown; createdAt?: unknown; timestamp?: unknown; expiresAt?: unknown; callId?: unknown } | null | undefined,
	liveSessions: ReadonlySet<string>,
	currentStartMs: number,
): boolean {
	if (!offer || liveSessions.size === 0) return false
	if (liveSessions.has(String(offer.sessionId || ''))) return false
	if (!isVoiceCallOfferRinging(offer as Parameters<typeof isVoiceCallOfferRinging>[0])) return false
	const offerMs = normalizeVoiceTimestampMs(offer.createdAt || offer.timestamp)
	return currentStartMs > 0 && offerMs > currentStartMs
}
