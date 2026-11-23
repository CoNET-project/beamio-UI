/**
 * Incoming voice offer dedup and late window (三端通用：iOS、Android、PWA 同口径).
 *
 * Source: draft-v36 第四十节（去重容量按主叫配额）与 draft-v37 第四十一节（迟到 offer 窗口）。
 *
 * - Dedup key: `JSON.stringify([callId, sessionId])`. Never `|` or `:`.
 * - Records are kept `VOICE_OFFER_DEDUP_RETAIN_MS` (1200 s) from registration and persisted.
 * - Per signed caller R (recovered EOA): at most `VOICE_OFFER_DEDUP_PER_CALLER_CAP` unexpired records.
 *   Over that cap only that R's new offer is refused, with a warning.
 * - Global cap `VOICE_OFFER_DEDUP_GLOBAL_CAP`. Only expired records are evicted. Still full: refuse the new
 *   offer and warn (accepted residual risk). Unexpired records are never evicted.
 * - Late window: an offer is accepted only while `now <= expiresAt` taken from the signed offer; the
 *   processing window is never longer than `expiresAt + 300 s`. `ringExpiresAt` never takes part.
 */

export const VOICE_OFFER_DEDUP_RETAIN_MS = 1_200_000
export const VOICE_OFFER_DEDUP_PER_CALLER_CAP = 50
export const VOICE_OFFER_DEDUP_GLOBAL_CAP = 1_000
export const VOICE_OFFER_LATE_GRACE_MS = 300_000

const DEDUP_STORAGE_KEY = 'beamio.voiceOfferDedup.v1'

type DedupRow = { key: string; caller: string; at: number }

export type VoiceOfferDedupResult =
	| { ok: true }
	| { ok: false; reason: 'duplicate' | 'caller_quota' | 'global_full' }

/** Canonical dedup key. Must match the other two platforms byte for byte. */
export function voiceOfferDedupKey(callId: string, sessionId: string): string {
	return JSON.stringify([String(callId).trim(), String(sessionId).trim()])
}

/** Accept both millisecond and Unix-second values (same rule as voiceCallSession). */
function toMs(value: unknown): number {
	const numeric = Number(value)
	if (!Number.isFinite(numeric) || numeric <= 0) return 0
	return numeric < 100_000_000_000 ? numeric * 1000 : numeric
}

/**
 * Late window (§41). `expiresAt` is the signed value. Refused when `now > expiresAt`, and never past
 * `expiresAt + 300 s`. Missing `expiresAt` is refused.
 */
export function voiceOfferWithinLateWindow(
	signal: { expiresAt?: unknown; createdAt?: unknown } | null | undefined,
	now = Date.now(),
): boolean {
	const expiresAtMs = toMs(signal?.expiresAt)
	if (!expiresAtMs) return false
	if (now > expiresAtMs) return false
	// v39 §43: the 300 s deviation only bounds issuedAt in the future (issuedAt > now + 300 s is refused). It never extends expiresAt.
	// v20 §22: a missing issue time is refused; an issue time more than 300 s ahead is refused.
	const issuedAtMs = toMs(signal?.createdAt)
	if (!issuedAtMs || issuedAtMs > now + VOICE_OFFER_LATE_GRACE_MS) return false
	return true
}

/**
 * §41.4 (draft-v37): the signed `from` must equal the recovered signer R; a missing or different `from` is refused,
 * and so is a missing `createdAt`. Returns the refusal reason, or null when the offer is admissible on these checks.
 */
export function voiceOfferAdmissibilityRefusal(
	signal: { from?: unknown; createdAt?: unknown; timestamp?: unknown } | null | undefined,
	signer: string | null,
): 'no_signer' | 'from_missing' | 'from_mismatch' | 'no_created_at' | null {
	if (!signer) return 'no_signer'
	const from = typeof signal?.from === 'string' ? signal.from.trim().toLowerCase() : ''
	if (!from) return 'from_missing'
	if (from !== signer.toLowerCase()) return 'from_mismatch'
	// v20 §22 / v21 §23: only createdAt is read; timestamp is never an issue time for verification.
	const createdMs = toMs(signal?.createdAt)
	if (!createdMs) return 'no_created_at'
	return null
}

export type VoiceOfferDedupStorage = Pick<Storage, 'getItem' | 'setItem'>

export type VoiceOfferDedup = {
	/** Register an offer whose signature recovered `caller`. Refused offers are not registered. */
	register(callId: string, sessionId: string, caller: string, now?: number): VoiceOfferDedupResult
	/** Read-only: was this (callId, sessionId) admitted and is the record still retained? Never writes. */
	isAdmitted(callId: string, sessionId: string, now?: number): boolean
	/** Test seam: drop the in-memory copy so the next call reloads from storage. */
	reloadForTest(): void
}

const browserStorage = (): VoiceOfferDedupStorage | null => {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

export function createVoiceOfferDedup(options: {
	storage?: VoiceOfferDedupStorage | null
	storageKey?: string
	warn?: (message: string) => void
} = {}): VoiceOfferDedup {
	const storage = options.storage === undefined ? browserStorage() : options.storage
	const storageKey = options.storageKey ?? DEDUP_STORAGE_KEY
	const warn = options.warn ?? ((message: string) => console.warn(message))
	let rows: DedupRow[] | null = null

	const load = (): DedupRow[] => {
		if (rows) return rows
		rows = []
		try {
			const raw = storage?.getItem(storageKey)
			const parsed = raw ? JSON.parse(raw) : []
			if (Array.isArray(parsed)) {
				for (const row of parsed) {
					if (
						row && typeof row.key === 'string' && typeof row.caller === 'string' &&
						typeof row.at === 'number' && Number.isFinite(row.at)
					) {
						rows.push({ key: row.key, caller: row.caller, at: row.at })
					}
				}
			}
		} catch {
			rows = []
		}
		return rows
	}

	const persist = (): void => {
		try {
			storage?.setItem(storageKey, JSON.stringify(rows ?? []))
		} catch {
			// Storage full or unavailable: keep the in-memory copy for this run.
		}
	}

	return {
		register(callId, sessionId, caller, now = Date.now()) {
			const key = voiceOfferDedupKey(callId, sessionId)
			const r = String(caller || '').toLowerCase()
			const list = load()
			// Evict expired records only. Unexpired records are never removed.
			const live = list.filter((row) => now - row.at <= VOICE_OFFER_DEDUP_RETAIN_MS)
			rows = live
			if (live.some((row) => row.key === key)) return { ok: false, reason: 'duplicate' }
			const perCaller = live.filter((row) => row.caller === r).length
			if (perCaller >= VOICE_OFFER_DEDUP_PER_CALLER_CAP) {
				warn(`[voice] offer refused: caller quota reached (${VOICE_OFFER_DEDUP_PER_CALLER_CAP} unexpired records)`)
				return { ok: false, reason: 'caller_quota' }
			}
			if (live.length >= VOICE_OFFER_DEDUP_GLOBAL_CAP) {
				warn(`[voice] offer refused: dedup table full (${VOICE_OFFER_DEDUP_GLOBAL_CAP} unexpired records)`)
				return { ok: false, reason: 'global_full' }
			}
			live.push({ key, caller: r, at: now })
			persist()
			return { ok: true }
		},
		isAdmitted(callId, sessionId, now = Date.now()) {
			const key = voiceOfferDedupKey(callId, sessionId)
			return load().some((row) => row.key === key && now - row.at <= VOICE_OFFER_DEDUP_RETAIN_MS)
		},
		reloadForTest() {
			rows = null
		},
	}
}

/** The one dedup table used by the incoming offer path on every platform. */
export const voiceOfferDedup: VoiceOfferDedup = createVoiceOfferDedup()
