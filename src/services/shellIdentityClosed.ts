/**
 * closed state of the shell's chat identity (option (a); Android review dfc05b7).
 *
 * When the native layer closes the module, the page does not retry on its own: it shows a notice with a button.
 * - `init` answers `clear_failed` (the module is closed until a clearIdentity succeeds), or `unregister_refused` (an account switch
 *   refused its recovery check, which only an import answers).
 * - The clear is two steps: the page asks for a confirmation, then sends `clearIdentity`. The native layer still runs its recovery
 *   source check first; when the check fails it refuses and deletes nothing. The page never deletes anything by itself.
 * - When the closed state came from an account import, the button leads back to the native import page instead (the native layer confirms).
 *
 * The copy is a placeholder pending final wording. SYNTHETIC values only: no key material here.
 */
import { requestNativeAck } from './nativeChatRouteRegister'

export type IdentityClosedReason = 'clear_failed' | 'unregister_refused'
export type IdentityClosedSource = 'clear' | 'import'
export type IdentityClosedState = { reason: IdentityClosedReason; source: IdentityClosedSource } | null

export const CLEAR_IDENTITY_COMMAND = 'clearIdentity'
/** A clear reads and writes the native stores and may run the on-chain unregistration; the same budget as init. */
export const CLEAR_IDENTITY_TIMEOUT_MS = 180_000

export function isIdentityClosedReason(value: unknown): value is IdentityClosedReason {
	return value === 'clear_failed' || value === 'unregister_refused'
}

/**
 * Where the closed state came from. `unregister_refused` is only answered by an account switch, so it is an import. `clear_failed` is an
 * import only when this page session saw a failed import (its answer came from the same switch); after a restart it is taken as a clear.
 */
export function identityClosedSource(reason: IdentityClosedReason, importSwitchFailedThisSession: boolean): IdentityClosedSource {
	if (reason === 'unregister_refused') return 'import'
	return importSwitchFailedThisSession ? 'import' : 'clear'
}

/**
 * - `ok`: the identity was cleared. The page reloads and re-judges the account.
 * - `refused`: `unregister_refused`. Nothing was removed; the user must back up the recovery code before a reset.
 * - `incomplete`: `clear_incomplete`. The clear did not finish; it may be retried. Nothing here counts as cleared or as "no account".
 * - `failed`: any other answer (`clear_failed`, `bad_request`, `busy`, a timeout, no channel). The closed notice stays as it is.
 */
export type ClearOutcome = { kind: 'ok' } | { kind: 'refused' } | { kind: 'incomplete' } | { kind: 'failed'; code: string }

/**
 * Maps the `clearIdentity` answer. An ack with `ok: true` is a clear and nothing else is. `unregister_refused` is a refusal, and
 * `clear_incomplete` is an unfinished clear that can be retried. Any other answer keeps the closed notice as it is.
 */
export function clearOutcomeOf(answer: { kind: string; payload?: Record<string, unknown> }): ClearOutcome {
	if (answer.kind !== 'payload' || !answer.payload) return { kind: 'failed', code: answer.kind }
	const payload = answer.payload
	if (payload.type === 'ack' && payload.ok === true) return { kind: 'ok' }
	const error = typeof payload.error === 'string' ? payload.error : 'unknown'
	if (error === 'unregister_refused') return { kind: 'refused' }
	if (error === 'clear_incomplete') return { kind: 'incomplete' }
	return { kind: 'failed', code: error }
}

// The closed state the notice reads. Set by the start when init is refused with a closed reason; cleared by a successful start or clear.
let closed: IdentityClosedState = null
const closedListeners = new Set<(value: IdentityClosedState) => void>()

export function getIdentityClosed(): IdentityClosedState {
	return closed
}

export function setIdentityClosed(next: IdentityClosedState): void {
	closed = next
	for (const listener of [...closedListeners]) listener(next)
}

export function subscribeIdentityClosed(listener: (value: IdentityClosedState) => void): () => void {
	closedListeners.add(listener)
	return () => {
		closedListeners.delete(listener)
	}
}

// Set when an import (an account switch) answers a closed reason in this page session.
let importFailed = false

export function markImportSwitchFailed(): void {
	importFailed = true
}

export function importSwitchFailedThisSession(): boolean {
	return importFailed
}

/** Sends `clearIdentity` and waits for its ack. The caller has confirmed the clear. */
export async function clearShellChatIdentity(): Promise<ClearOutcome> {
	const answer = await requestNativeAck({ type: CLEAR_IDENTITY_COMMAND }, CLEAR_IDENTITY_TIMEOUT_MS)
	return clearOutcomeOf(answer as { kind: string; payload?: Record<string, unknown> })
}
