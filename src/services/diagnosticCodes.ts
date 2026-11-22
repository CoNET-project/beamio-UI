/**
 * Printable diagnostic codes. A code value in a diagnostic line is printed as itself
 * only when it is listed here; anything else prints as `other`.
 * Field NAMES are filtered separately by the callers.
 *
 * Provenance of each listed code:
 * - read answers: (absent, ok, error, migrating, too_large, not_ready, not_ready_persistent, storage_locked,
 * ambiguous_accounts, unreadable, entitlement, device_locked, g1_uninitialized);
 * - wallet-record codes checked against the spec: bad_request, key_over_bridge_refused, record_unreadable, wallet_copy_not_approved,
 * legacy_store_unreadable, address_mismatch, conflict, pgp_private_in_payload;
 * - not_trusted: and. Only for package verification or capability failure in walletEoaAddress
 * and walletCredential;
 * - origin_refused: and. A source or frame that does not match, on any new command;
 * - untrusted_source: the closed set of old commands; it is not used by new commands;
 * - import_not_done:
 * - not_supported, locked, no_key: (the clauses that cover each native answer);
 * - too_large: the status of an answer over its size limit only (never a request code);
 * - not_reported, key_only, unknown, present, unavailable: the walletState and walletStatus entries.
 * Removed by (printed as other): bad_answer, native_unavailable, unknown_command, timeout, unlocked, corrupt.
 */
export const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
	// read answers
	'absent', 'ok', 'error', 'migrating', 'too_large', 'not_ready', 'not_ready_persistent', 'storage_locked', 'ambiguous_accounts',
	'unreadable', 'entitlement', 'device_locked', 'g1_uninitialized',
	// wallet-record codes (Chat SDK seat's spec check)
	'bad_request', 'key_over_bridge_refused', 'not_trusted', 'record_unreadable', 'wallet_copy_not_approved', 'legacy_store_unreadable',
	'address_mismatch', 'conflict', 'pgp_private_in_payload',
	// refusals and native states the shell really returns (provenance above)
	'untrusted_source', 'origin_refused', 'import_not_done', 'not_supported', 'locked', 'no_key', 'not_reported', 'key_only',
	'unknown', 'present', 'unavailable', 'too_large',
	// 0.53.44: a page write refused by the overwrite floor (counted; no UI)
	'page_record_overwrite_refused',
	'other',
])

/** The printable form of a code: itself when listed, otherwise `other`. Never the value of a free text or a secret. */
export function diagnosticCode(value: unknown): string {
	return typeof value === 'string' && DIAGNOSTIC_CODES.has(value) ? value : 'other'
}
