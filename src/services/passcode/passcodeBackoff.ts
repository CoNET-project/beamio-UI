/**
 * UI-side unlock backoff (project rule 4bc1a2ac; FROZEN protocol section five, 5.1 to 5.2). Pure rules plus a store interface.
 *
 * - the third consecutive wrong input locks for LOCK_MS (300 000 ms, 5 minutes) from the moment of that failure;
 * - after the lock expires one attempt is allowed; the failure count is kept, so a wrong input locks again for the full LOCK_MS;
 * - only a correct unlock of the UI clears the count;
 * - one input counts once; the count is written BEFORE the input is judged; a write that fails refuses the attempt (no release);
 * - a read that fails is unknown: the attempt is refused, and nothing is written;
 * - a clock that runs back (now earlier than the last recorded failure) is an abnormal state: the lock restarts from now, for the full LOCK_MS.
 * Forward clock jumps cannot be detected (known limit, written into the freeze note).
 * The native side never counts (protocol 5.3): this count is the only control.
 */

export const LOCK_MS = 300_000
export const LOCK_AFTER = 3

export interface AttemptState {
	/** consecutive wrong inputs, kept across an expiry until a correct unlock */
	failures: number
	/** epoch ms until which attempts are refused (0 = not locked) */
	lockedUntilMs: number
	/** epoch ms of the last recorded failure (0 = none) */
	lastFailureMs: number
}

export const ZERO_ATTEMPTS: AttemptState = { failures: 0, lockedUntilMs: 0, lastFailureMs: 0 }

export type Gate = { kind: 'allowed' } | { kind: 'locked'; retryAfterMs: number; rolledBack: boolean }

/** Whether an attempt may be judged now. A clock that ran back locks for the full LOCK_MS from now. */
export function gateAt(state: AttemptState, nowMs: number): Gate {
	if (state.lastFailureMs > 0 && nowMs < state.lastFailureMs) {
		return { kind: 'locked', retryAfterMs: LOCK_MS, rolledBack: true }
	}
	if (nowMs < state.lockedUntilMs) return { kind: 'locked', retryAfterMs: state.lockedUntilMs - nowMs, rolledBack: false }
	return { kind: 'allowed' }
}

/** The state after one wrong input at nowMs. The lock starts at the third and later failures (each one locks for the full LOCK_MS). */
export function afterFailure(state: AttemptState, nowMs: number): AttemptState {
	const failures = state.failures + 1
	return {
		failures,
		lockedUntilMs: failures >= LOCK_AFTER ? nowMs + LOCK_MS : 0,
		lastFailureMs: nowMs,
	}
}

/** The state after a correct unlock: the count is cleared. */
export function afterSuccess(): AttemptState {
	return { ...ZERO_ATTEMPTS }
}

/** The state written when a clock rollback is seen: the lock restarts from now, for the full LOCK_MS (fail closed). */
export function afterRollback(state: AttemptState, nowMs: number): AttemptState {
	return { ...state, lockedUntilMs: nowMs + LOCK_MS, lastFailureMs: nowMs }
}

/** The persisted record (passcodeAttempt document). A read that throws is unknown, never a zero count. */
export interface AttemptStore {
	read(): Promise<AttemptState | null>
	write(state: AttemptState): Promise<void>
}

export type AttemptOutcome =
	| { kind: 'correct' }
	| { kind: 'wrong'; retryAfterMs: number; locked: boolean }
	| { kind: 'locked'; retryAfterMs: number; rolledBack: boolean }
	| { kind: 'refused'; reason: 'read_failed' | 'write_failed' }

/**
 * One unlock attempt with one input. Order (protocol 5.2): read the state; refuse while locked (no comparison); count the failure and write it
 * BEFORE the comparison; then, on a correct input, clear the count and write that. A failed write refuses the attempt and does not compare.
 */
export async function attemptUnlock(
	store: AttemptStore,
	nowMs: number,
	verify: () => Promise<boolean>,
): Promise<AttemptOutcome> {
	let state: AttemptState | null
	try {
		state = (await store.read()) ?? { ...ZERO_ATTEMPTS }
	} catch {
		return { kind: 'refused', reason: 'read_failed' }
	}
	const gate = gateAt(state, nowMs)
	if (gate.kind === 'locked') {
		if (gate.rolledBack) {
			const restarted = afterRollback(state, nowMs)
			try {
				await store.write(restarted)
			} catch {
				return { kind: 'refused', reason: 'write_failed' }
			}
		}
		return { kind: 'locked', retryAfterMs: gate.retryAfterMs, rolledBack: gate.rolledBack }
	}
	// the wrong-input count is written before the judgement; if the input turns out correct, the count is cleared right after
	const counted = afterFailure(state, nowMs)
	try {
		await store.write(counted)
	} catch {
		return { kind: 'refused', reason: 'write_failed' }
	}
	const ok = await verify()
	if (ok) {
		try {
			await store.write(afterSuccess())
		} catch {
			return { kind: 'refused', reason: 'write_failed' }
		}
		return { kind: 'correct' }
	}
	return { kind: 'wrong', retryAfterMs: counted.lockedUntilMs > nowMs ? counted.lockedUntilMs - nowMs : 0, locked: counted.lockedUntilMs > nowMs }
}

/** An in-memory store for tests and for the single-process path (the production store is the passcodeAttempt document). */
export function memoryAttemptStore(initial: AttemptState | null = null): AttemptStore & { value: AttemptState | null } {
	const holder: { value: AttemptState | null } = { value: initial }
	return {
		get value() {
			return holder.value
		},
		set value(v: AttemptState | null) {
			holder.value = v
		},
		async read() {
			return holder.value ? { ...holder.value } : null
		},
		async write(state: AttemptState) {
			holder.value = { ...state }
		},
	}
}
