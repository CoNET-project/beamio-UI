/**
 * PGP migration, page side (integration events of the shared PGP migration vectors).
 *
 * The page holds no PGP key. It sends one command, `pgpMigrate`, with `type` and `reqId` only, and reads the ack and the
 * `pgpMigrateResult` event. The event carries a code and the first 16 characters of the fingerprint (public). Any other field
 * is dropped, and only its name is reported. The page never sends or receives a key.
 */

/** The command type. The request carries `type` and `reqId` and nothing else (the SDK refuses any other field). */
export const PGP_MIGRATE_COMMAND = 'pgpMigrate'
export const PGP_MIGRATE_RESULT_EVENT = 'pgpMigrateResult'

/** Result codes of  that count as success. */
const SUCCESS_CODES = new Set(['ok', 'already_verified'])
/** Retryable failures of  (the page offers a retry; the next start sends pgpMigrate again). */
const RETRYABLE_CODES = new Set(['chain_unavailable', 'write_failed', 'reread_failed', 'challenge_failed'])
/**
 * not retried automatically, reported for a person to handle (iOS SDK 60f234b: fingerprint_mismatch is
 * "需人工处理的失败"; legacy_unreadable and account_mismatch are reported the same way by the spec).
 */
const MANUAL_CODES = new Set(['fingerprint_mismatch', 'legacy_unreadable', 'account_mismatch'])
/**no legacy key and no store (none) or only the chain mirror (store_missing): the  route, not a failure. */
const CHAIN_BACKUP_CODES = new Set(['none', 'store_missing'])
/** The only fields a result event may carry. */
const EVENT_FIELDS = new Set(['type', 'reqId', 'code', 'fp'])

type Loose = Record<string, unknown>

export type MigrationEventDecision =
	| { action: 'success'; reason: null; fields: [] }
	| { action: 'failure'; reason: 'reported_failure' | 'unknown_code'; fields: [] }
	/** Not a failure: the release gate of the SDK is closed. Nothing was written; retry after approval. */
	| { action: 'blocked'; reason: 'verify_unavailable'; fields: [] }
	/** Reported for a person to handle; not retried automatically. */
	| { action: 'manual'; reason: 'fingerprint_mismatch' | 'legacy_unreadable' | 'account_mismatch'; fields: [] }
	/** No legacy key and no store: the  route, not a failure. */
	| { action: 'chain_backup'; reason: 'none' | 'store_missing'; fields: [] }
	| { action: 'drop'; reason: 'field_not_allowed' | 'reqid_mismatch' | 'not_migration_event'; fields: string[] }

/** The command to send: `type` and `reqId` only. */
export function buildPgpMigrateCommand(reqId: number): { type: string; reqId: number } {
	return { type: PGP_MIGRATE_COMMAND, reqId }
}

/** Decides what one `pgpMigrateResult` event means for the page. Field names are checked first; no value is read. */
export function interpretPgpMigrateEvent(evt: Loose, pendingReqId: number | null): MigrationEventDecision {
	if (evt.type !== PGP_MIGRATE_RESULT_EVENT) return { action: 'drop', reason: 'not_migration_event', fields: [] }
	const extra = Object.keys(evt).filter((k) => !EVENT_FIELDS.has(k)).sort()
	if (extra.length) return { action: 'drop', reason: 'field_not_allowed', fields: extra }
	if (pendingReqId === null || evt.reqId !== pendingReqId) return { action: 'drop', reason: 'reqid_mismatch', fields: [] }
	const code = typeof evt.code === 'string' ? evt.code : ''
	if (SUCCESS_CODES.has(code)) return { action: 'success', reason: null, fields: [] }
	if (code === 'verify_unavailable') return { action: 'blocked', reason: 'verify_unavailable', fields: [] }
	if (MANUAL_CODES.has(code)) return { action: 'manual', reason: code as 'fingerprint_mismatch' | 'legacy_unreadable' | 'account_mismatch', fields: [] }
	if (CHAIN_BACKUP_CODES.has(code)) return { action: 'chain_backup', reason: code as 'none' | 'store_missing', fields: [] }
	if (RETRYABLE_CODES.has(code)) return { action: 'failure', reason: 'reported_failure', fields: [] }
	return { action: 'failure', reason: 'unknown_code', fields: [] }
}

/** The page-side state of one migration run (no key material). */
export type MigrationPageState =
	| 'running'
	| 'verified'
	/** A retryable failure (chain_unavailable, write_failed, reread_failed, challenge_failed) or an interruption (timeout). */
	| 'retryable'
	/** Waiting for the project owner's approval of the SDK gate; retry after approval (verify_unavailable). */
	| 'approval_pending'
	/** Needs a person (fingerprint_mismatch, legacy_unreadable, account_mismatch). Not retried automatically. */
	| 'needs_manual'
	/** The  route (none, store_missing). Not a failure. */
	| 'chain_backup'
	| 'unavailable'
	| 'locked'
	| 'busy'
	| 'refused'

/** Maps an ack to the page state. An ack that is not `accepted` ends the run before any event. */
export function pageStateForAck(ack: Loose | null): MigrationPageState | null {
	if (!ack) return 'retryable'
	if (ack.type !== 'ack') return 'retryable'
	if (ack.ok === true) return null
	const error = typeof ack.error === 'string' ? ack.error : ''
	if (error === 'no_key' || error === 'not_ready') return 'unavailable'
	if (error === 'locked') return 'locked'
	if (error === 'busy') return 'busy'
	if (error === 'bad_request' || error === 'key_over_bridge_refused') return 'refused'
	return 'retryable'
}

/** The page state after a decided event. */
export function pageStateForDecision(d: MigrationEventDecision): MigrationPageState | null {
	if (d.action === 'success') return 'verified'
	if (d.action === 'failure') return 'retryable'
	if (d.action === 'blocked') return 'approval_pending'
	if (d.action === 'manual') return 'needs_manual'
	if (d.action === 'chain_backup') return 'chain_backup'
	return null
}

/**
 * Runs one migration on the injected channel: `send` posts the command and resolves with the ack; `subscribe` delivers the
 * events. Resolves with the page state. A dropped event keeps waiting; a timeout is retryable.
 */
export async function runPgpMigration(deps: {
	reqId: number
	send: (cmd: { type: string; reqId: number }) => Promise<Loose | null>
	subscribe: (onEvent: (evt: Loose) => void) => () => void
	timeoutMs: number
}): Promise<MigrationPageState> {
	const ack = await deps.send(buildPgpMigrateCommand(deps.reqId))
	const ackState = pageStateForAck(ack)
	if (ackState) return ackState
	return new Promise<MigrationPageState>((resolve) => {
		let off: (() => void) | null = null
		const timer = setTimeout(() => {
			off?.()
			resolve('retryable')
		}, deps.timeoutMs)
		off = deps.subscribe((evt) => {
			const decided = interpretPgpMigrateEvent(evt, deps.reqId)
			const state = pageStateForDecision(decided)
			if (!state) return
			clearTimeout(timer)
			off?.()
			resolve(state)
		})
	})
}
