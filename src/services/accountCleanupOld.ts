/**
 * accountCleanupOld (Y.91, CU-01 to CU-08). The page sends it only after the user has completed the recovery and confirmed it on the native
 * screen; entering onboarding never triggers it. The command carries exactly {type, reqId, accountKey, idempotencyKey}: the confirmation is
 * never a field of the page's payload (Y.91 3). A `clear_incomplete` is resumed with the same idempotencyKey, and until the cleanup finishes the
 * page never treats the account as absent (Y.91 7). Only a result with ok removes the old storage; a refused result removes nothing.
 */
import { requestNativeAck } from './nativeChatRouteRegister'

export const ACCOUNT_CLEANUP_OLD_COMMAND = 'accountCleanupOld'
/** A cleanup reads and removes the native stores; the same budget as clearIdentity. */
export const ACCOUNT_CLEANUP_TIMEOUT_MS = 180_000
const CLEANUP_REQ_BASE = 770_000_000
let cleanupSeq = 0

export type AccountCleanupCommand = { type: 'accountCleanupOld'; reqId: number; accountKey: string; idempotencyKey: string }

/** The only command shape the page sends: four fields, no confirmation. */
export function buildAccountCleanupOldCommand(accountKey: string, idempotencyKey: string): AccountCleanupCommand {
	cleanupSeq += 1
	return { type: ACCOUNT_CLEANUP_OLD_COMMAND, reqId: CLEANUP_REQ_BASE + cleanupSeq, accountKey, idempotencyKey }
}

export type AccountCleanupOutcome = { kind: 'ok' } | { kind: 'incomplete' } | { kind: 'refused'; code: string }

/** Maps the ack. `ok` is the only success; `clear_incomplete` is resumable; any other error is a refusal that removed nothing. */
export function accountCleanupOutcomeOf(answer: { kind: string; payload?: Record<string, unknown> }): AccountCleanupOutcome {
	if (answer.kind !== 'payload' || !answer.payload) return { kind: 'refused', code: answer.kind }
	const p = answer.payload
	if (p.type === 'ack' && p.ok === true) return { kind: 'ok' }
	const error = typeof p.error === 'string' ? p.error : 'unknown'
	if (error === 'clear_incomplete') return { kind: 'incomplete' }
	return { kind: 'refused', code: error }
}

export type AccountCleanupSend = (cmd: AccountCleanupCommand) => Promise<{ kind: string; payload?: Record<string, unknown> }>

/**
 * Runs the cleanup for one idempotencyKey. An incomplete answer is resumed with the same key (up to `maxAttempts`); the result is `ok` only
 * when the native layer says so. An exhausted incomplete result stays incomplete: the caller keeps the cleanup pending and the account is not
 * treated as absent.
 */
export async function runAccountCleanupOld(params: { accountKey: string; idempotencyKey: string; send: AccountCleanupSend; maxAttempts?: number }): Promise<AccountCleanupOutcome> {
	const maxAttempts = params.maxAttempts ?? 3
	let last: AccountCleanupOutcome = { kind: 'incomplete' }
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		// the same idempotencyKey on every attempt: the native layer finishes only the old items that remain (CU-07, CU-08).
		const cmd = buildAccountCleanupOldCommand(params.accountKey, params.idempotencyKey)
		last = accountCleanupOutcomeOf(await params.send(cmd))
		if (last.kind !== 'incomplete') return last
	}
	return last
}

/** Default transport: the shell's ack for the command (the cleanup budget). */
export const sendAccountCleanupOld: AccountCleanupSend = (cmd) => requestNativeAck(cmd, ACCOUNT_CLEANUP_TIMEOUT_MS, cmd.reqId)
