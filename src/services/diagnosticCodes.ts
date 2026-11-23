/**
 * Printable diagnostic codes (2026-11-21; the Chat SDK rule v164 §184.3). A code value in a diagnostic line is printed as itself
 * only when it is listed here; anything else (a free text, a mnemonic word, a value, or a code removed by v164) prints as `other`.
 * Field NAMES are filtered separately by the callers.
 *
 * Provenance of each listed code (v164 §184 and the clauses it cites):
 * - read answers: v159 §179, v161 §181, v162 §182 (absent, ok, error, migrating, too_large, not_ready, not_ready_persistent, storage_locked,
 *   ambiguous_accounts, unreadable, entitlement, device_locked, g1_uninitialized);
 * - wallet-record codes checked against the spec: bad_request, key_over_bridge_refused, record_unreadable, wallet_copy_not_approved,
 *   legacy_store_unreadable, address_mismatch, conflict, pgp_private_in_payload;
 * - not_trusted: v164 §184.1 and §184.3 (§25.52Y.44 item 4; r3os). Only for package verification or capability failure in walletEoaAddress
 *   and walletCredential;
 * - origin_refused: v164 §184.1 and §184.3 (§25.52Y.44 item 4; r3ox). A source or frame that does not match, on any new command;
 * - untrusted_source: v164 §184.1, the closed set of old commands (r2.4.6, r2.5.7); it is not used by new commands;
 * - import_not_done: §25.52K.4;
 * - not_supported, locked, no_key: v164 §184.3 (the clauses that cover each native answer);
 * - too_large: the status of an answer over its size limit only (never a request code);
 * - not_reported, key_only, unknown, present, unavailable: v164 §184.3, the walletState and walletStatus entries.
 * Removed by v164 §184.3 (printed as other): unknown_command, timeout, unlocked, corrupt.
 * bad_answer and native_unavailable were removed by v164 but are reinstated as PWA-internal reasons (interface, 0.53.44; see below).
 */
export const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
	// read answers
	'absent', 'ok', 'error', 'migrating', 'too_large', 'not_ready', 'not_ready_persistent', 'storage_locked', 'ambiguous_accounts',
	'unreadable', 'entitlement', 'device_locked', 'g1_uninitialized',
	// wallet-record codes (Chat SDK spec check)
	'bad_request', 'key_over_bridge_refused', 'not_trusted', 'record_unreadable', 'wallet_copy_not_approved', 'legacy_store_unreadable',
	'address_mismatch', 'conflict', 'pgp_private_in_payload',
	// refusals and native states the shell really returns (provenance above)
	'untrusted_source', 'origin_refused', 'import_not_done', 'not_supported', 'locked', 'no_key', 'not_reported', 'key_only',
	'unknown', 'present', 'unavailable', 'too_large',
	// 0.53.44: a page write refused by the overwrite floor (counted; no UI)
	'page_record_overwrite_refused',
	// 0.53.44 (interface): PWA-internal parse reasons, printed by name only (no value). This is a
	// closed set: anything else stays other. The v164 §184.3 removals above govern the wire answer codes, not these internal reasons.
	'rev_missing', 'bad_answer', 'wallet_fields_missing', 'wallet_fields_redacted', 'native_unavailable', 'needs_native_recovery',
	// Unit g (2026-11-22): the native passcode is not provided (a not_ready class, background wait; never onboarding, never counted, never confirmed_missing)
	'passcode_not_provided',
	// Unit g (rev): the walletStatus not_ready reason, printed as its own code (pending sync; not a landing decision)
	'native_passcode_not_provided',
	// Unit g: a passcode account is reported by one source while the pre-read answers absent: an inconsistency, never onboarding
	'passcode_preread_inconsistent',
	'other',
])

/** The printable form of a code: itself when listed, otherwise `other`. Never the value of a free text or a secret. */
export function diagnosticCode(value: unknown): string {
	return typeof value === 'string' && DIAGNOSTIC_CODES.has(value) ? value : 'other'
}
