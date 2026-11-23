/**
 * Receiving end of the incoming-call unlock (v114 §133, 2026-11-21). Pure: parsing, countdown, the Shown rule, and the caller
 * display rule. The overlay and the bridge calls are wired elsewhere.
 *
 * - Running shell: event `incomingCallUnlockRequest`. Cold start: launch parameter `incomingCallUnlock`. Same shape:
 *   {callId, eoa, remainingMs, phase}. Any missing field, wrong type, remainingMs <= 0, or phase outside load|input: refused
 *   (fail closed). Nothing is inferred and nothing is filled in to the full amount.
 * - remainingMs counts from the shell's generation moment, so the page starts its countdown from the moment it receives it.
 */

export type UnlockPhase = 'load' | 'input'

export type IncomingUnlockRequest = { callId: string; eoa: string; remainingMs: number; phase: UnlockPhase }

const CALL_ID = /^[A-Za-z0-9_-]{8,128}$/
const EOA = /^0x[0-9a-f]{40}$/

/** Parses the shell payload. `currentEoa` is the page's account; the request's eoa must equal it. Null when refused. */
export function parseIncomingUnlockRequest(raw: unknown, currentEoa: string): IncomingUnlockRequest | null {
	if (!raw || typeof raw !== 'object') return null
	const r = raw as Record<string, unknown>
	if (typeof r.callId !== 'string' || !CALL_ID.test(r.callId)) return null
	if (typeof r.eoa !== 'string' || !EOA.test(r.eoa)) return null
	if (r.eoa !== currentEoa.toLowerCase()) return null
	if (typeof r.remainingMs !== 'number' || !Number.isSafeInteger(r.remainingMs) || r.remainingMs < 1) return null
	if (r.phase !== 'load' && r.phase !== 'input') return null
	return { callId: r.callId, eoa: r.eoa, remainingMs: r.remainingMs, phase: r.phase }
}

/** The milliseconds left at `nowMs`, from the moment the request arrived. Never more than the shell's remainingMs; 0 when spent. */
export function remainingAt(req: { remainingMs: number }, arrivedAtMs: number, nowMs: number): number {
	const elapsed = Math.max(0, nowMs - arrivedAtMs)
	return Math.max(0, req.remainingMs - elapsed)
}

/** The page sends `incomingCallUnlockShown {callId}` once, and only for phase load (input: the shell already has it, v114 §133.2). */
export function shouldSendShown(req: { phase: UnlockPhase }, alreadySent: boolean): boolean {
	return req.phase === 'load' && !alreadySent
}

/**
 * The caller shown in the incoming window (v116 §135, transitional, 2026-11-21). The identity shown is the verified `from`, as a
 * short address. No name is looked up: this version takes no name from the local contacts (the same in all three clients). A peer
 * tag is only a secondary text marked unverified, and never replaces or overrides the address.
 */
export function callerDisplay(input: { verifiedFrom: string; peerTag?: string | null }): {
	address: string
	shortAddress: string
	name: null
	tag: string | null
	tagVerified: false
} {
	const address = input.verifiedFrom.toLowerCase()
	return {
		address,
		shortAddress: `${address.slice(0, 6)}…${address.slice(-4)}`,
		name: null,
		tag: input.peerTag && input.peerTag.trim() ? input.peerTag.trim() : null,
		tagVerified: false,
	}
}
