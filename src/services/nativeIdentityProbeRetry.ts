/**
 * The identity capability state the gate last saw, and the re-probe cadence for an unanswered hello.
 *
 * A hello that gets no answer (or a refusal) is treated as "capability not confirmed": no identity payload is sent.
 * The gate probes again while the answer is missing: 10 s, 30 s, 60 s, then every 60 s. A manual retry starts the
 * cadence again. The probing stops once the hello answers.
 */
import type { IdentityCapabilityState } from './shellEntryDecision'

/** `unknown` until the gate has asked the native shell for the first time. */
export type IdentityCapabilityStatus = IdentityCapabilityState | 'unknown'

/**
 * The delay before the next automatic probe, given how many automatic probes have already run since the last start or
 * manual retry: the first 10 s, the second 30 s, and 60 s from then on.
 */
export function identityProbeDelayMs(probesDone: number): number {
	if (probesDone <= 0) return 10_000
	if (probesDone === 1) return 30_000
	return 60_000
}

let current: IdentityCapabilityStatus = 'unknown'
const stateListeners = new Set<() => void>()
const retryListeners = new Set<() => void>()

export function getNativeIdentityCapability(): IdentityCapabilityStatus {
	return current
}

export function setNativeIdentityCapability(next: IdentityCapabilityStatus): void {
	if (next === current) return
	current = next
	for (const listener of stateListeners) listener()
}

export function subscribeNativeIdentityCapability(listener: () => void): () => void {
	stateListeners.add(listener)
	return () => {
		stateListeners.delete(listener)
	}
}

/** A manual retry from the identity hint or the retry screen. The gate starts the probe cadence again. */
export function requestNativeIdentityRetry(): void {
	for (const listener of retryListeners) listener()
}

export function onNativeIdentityRetryRequested(listener: () => void): () => void {
	retryListeners.add(listener)
	return () => {
		retryListeners.delete(listener)
	}
}
