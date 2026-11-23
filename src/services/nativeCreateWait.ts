/**
 * v10.2 r4 §2.2 (CT series): the wait for a native create result. The result event ends the wait first. Only after 10 minutes with no
 * result event does the wait fall back: the page stops waiting (the wait state only, nothing is judged failed, nothing is remembered).
 * A new create request after the fallback is admitted only by PWA-RETRY-03: reread walletEoaAddress first; an unknown reread does not
 * send; a late result of the old request is not a second completion. A create is never started automatically.
 */
import { rereadDecision, type RereadAnswer } from './manualRetryReread'

export const NATIVE_CREATE_FALLBACK_MS = 10 * 60 * 1000

/** `cancelled`: the user cancelled (or the page was closed). A late terminal result of the same request is still delivered once (r5 §五, CT-16b). */
export type CreateWaitState =
	| { kind: 'idle' }
	| { kind: 'pending'; id: number; startedAt: number }
	| { kind: 'fallback'; id: number }
	| { kind: 'cancelled'; id: number }

export function startCreateWait(now: number, id: number): CreateWaitState {
	return { kind: 'pending', id, startedAt: now }
}

/** The fallback moment: 10 minutes after the start (9:59 is still pending; 10:00 falls back). */
export function tickCreateWait(s: CreateWaitState, now: number): CreateWaitState {
	if (s.kind === 'pending' && now - s.startedAt >= NATIVE_CREATE_FALLBACK_MS) return { kind: 'fallback', id: s.id }
	return s
}

/**
 * A result event. Delivered once: while pending (event first) or after the fallback (a late result of the same request). After a result
 * is delivered the wait is idle, so a second result is dropped. A result with no wait is dropped.
 */
export function onCreateResult(s: CreateWaitState): { deliver: boolean; state: CreateWaitState } {
	if (s.kind === 'pending' || s.kind === 'fallback' || s.kind === 'cancelled') return { deliver: true, state: { kind: 'idle' } }
	return { deliver: false, state: s }
}

/**
 * The user cancels the wait (the cancel control) or the native page reports `cancelled` (the page was closed): the wait ends, nothing is
 * judged, and a retry is admitted (v10.2 r5 §四, CT-15 / CT-15b). Delivered once; a cancel with no wait is a no-op.
 */
export function cancelCreateWait(s: CreateWaitState): CreateWaitState {
	if (s.kind === 'pending' || s.kind === 'fallback') return { kind: 'cancelled', id: s.id }
	return s
}

/**
 * Whether a new create request may be sent now (v10.2 r4 §2.2 and r5 §二, CT-13): while pending, never; after a fallback alone (the native
 * page may still be open), never; after a terminal result or a cancel the wait is idle, and then a new create is admitted only with a
 * valid or absent reread of walletEoaAddress (PWA-RETRY-03). A fresh page with no earlier wait is idle and admitted.
 */
export function canStartCreate(s: CreateWaitState, reread: RereadAnswer): boolean {
	// r7 §一 (CT-15): after a cancel the retry is unavailable until the terminal result event of the same request (cancelled included) arrives.
	if (s.kind === 'pending' || s.kind === 'fallback' || s.kind === 'cancelled') return false
	return rereadDecision(reread) === 'send'
}

/** The timer that drives the fallback. Returns a cancel function. A result before 10 minutes cancels it (event first). */
export function scheduleCreateFallback(onFallback: () => void): () => void {
	const handle = setTimeout(onFallback, NATIVE_CREATE_FALLBACK_MS)
	return () => clearTimeout(handle)
}
