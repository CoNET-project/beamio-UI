/**
 * `firstIdentityStatus` (frozen protocol v1 §2; QA builds only until accepted). The SDK reports the first chat identity's registration on its own;
 * the page only shows it and re-reads identityPublic. The page never sends a create command because of it.
 *
 * The event carries a state and optional reason, attempt and retryAfterMs, and nothing else. Anything with another key is dropped. Terminal states
 * (registered, failed) are not overwritten by a later event. Only the state name and the reason are ever logged.
 */
import { FIRST_IDENTITY_STATUS_ENABLED } from '@/utils/accountCreateRegisterFlag'
import { eventPayloadOf, NATIVE_EVENT_NAMES } from './nativeKeyState'

export const FIRST_IDENTITY_STATUS_EVENT = 'firstIdentityStatus'
export type FirstIdentityState = 'registering' | 'registered' | 'retry_later' | 'identity_pending' | 'failed'
export const FIRST_IDENTITY_STATES: readonly FirstIdentityState[] = ['registering', 'registered', 'retry_later', 'identity_pending', 'failed']
const REASONS: readonly string[] = ['no_record_confirmed', 'read_unavailable', 'submit_5xx', 'submit_4xx', 'conflict_other_key', 'readback_timeout']
const KEYS: ReadonlySet<string> = new Set(['type', 'state', 'reason', 'attempt', 'retryAfterMs'])

export type FirstIdentityStatus = { state: FirstIdentityState; reason?: string; attempt?: number; retryAfterMs?: number }

export function parseFirstIdentityStatusEvent(payload: unknown): FirstIdentityStatus | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
	const o = payload as Record<string, unknown>
	if (o.type !== FIRST_IDENTITY_STATUS_EVENT) return null
	for (const k of Object.keys(o)) if (!KEYS.has(k)) return null
	if (typeof o.state !== 'string' || !(FIRST_IDENTITY_STATES as readonly string[]).includes(o.state)) return null
	const state = o.state as FirstIdentityState
	const out: FirstIdentityStatus = { state }
	// a reason outside the list is unknown: the state still counts, the reason is dropped
	if (typeof o.reason === 'string' && REASONS.includes(o.reason)) out.reason = o.reason
	if (o.attempt !== undefined) {
		if (typeof o.attempt !== 'number' || !Number.isInteger(o.attempt) || o.attempt < 1) return null
		out.attempt = o.attempt
	}
	if (o.retryAfterMs !== undefined) {
		// only retry_later carries it
		if (state !== 'retry_later' || typeof o.retryAfterMs !== 'number' || !Number.isFinite(o.retryAfterMs) || o.retryAfterMs < 0) return null
		out.retryAfterMs = Math.floor(o.retryAfterMs)
	}
	return out
}

const TERMINAL: readonly FirstIdentityState[] = ['registered', 'failed']
let last: FirstIdentityStatus | null = null
const listeners = new Set<(s: FirstIdentityStatus) => void>()

export function getFirstIdentityStatus(): FirstIdentityStatus | null {
	return last
}
export function subscribeFirstIdentityStatus(listener: (s: FirstIdentityStatus) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Records one event. A terminal state is kept: later events change nothing. Returns whether the event was taken. */
export function recordFirstIdentityStatus(s: FirstIdentityStatus): boolean {
	if (last && TERMINAL.includes(last.state)) return false
	last = s
	for (const l of [...listeners]) l(s)
	return true
}

let installed = false
export function installFirstIdentityStatusListener(): void {
	if (!FIRST_IDENTITY_STATUS_ENABLED || installed || typeof window === 'undefined') return
	installed = true
	const handler = (ev: Event) => {
		const s = parseFirstIdentityStatusEvent(eventPayloadOf(ev))
		if (s) recordFirstIdentityStatus(s)
	}
	for (const name of NATIVE_EVENT_NAMES) window.addEventListener(name, handler)
}

export function resetFirstIdentityStatusForTest(): void {
	last = null
	listeners.clear()
}
