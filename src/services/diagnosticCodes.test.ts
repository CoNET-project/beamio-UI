/**
 * The printable code whitelist (2026-11-21; Chat SDK spec check): listed codes print as themselves, anything else as other.
 */
import { diagnosticCode, DIAGNOSTIC_CODES } from './diagnosticCodes'

describe('diagnosticCode (the spec-checked whitelist)', () => {
	it('the codes kept with provenance are printable (v164 §184.3)', () => {
		for (const c of ['not_supported', 'locked', 'no_key', 'not_reported', 'key_only', 'unknown', 'present', 'unavailable']) {
			expect(diagnosticCode(c)).toBe(c)
		}

		for (const c of ['bad_request', 'key_over_bridge_refused', 'not_trusted', 'record_unreadable', 'wallet_copy_not_approved', 'legacy_store_unreadable', 'address_mismatch', 'conflict', 'pgp_private_in_payload', 'untrusted_source']) {
			expect(DIAGNOSTIC_CODES.has(c)).toBe(true)
			expect(diagnosticCode(c)).toBe(c)
		}
	})
	it('codes removed by v164 are not printable (the wire answer codes)', () => {
		for (const c of ['unknown_command', 'timeout', 'unlocked', 'corrupt']) {
			expect(diagnosticCode(c)).toBe('other')
		}
	})
	it('the PWA-internal parse reasons form a closed set and print by name (0.53.44, interface maintainers rule)', () => {
		for (const c of ['rev_missing', 'bad_answer', 'wallet_fields_missing', 'wallet_fields_redacted', 'native_unavailable', 'needs_native_recovery']) {
			expect(DIAGNOSTIC_CODES.has(c)).toBe(true)
			expect(diagnosticCode(c)).toBe(c)
		}
		// outside the closed set: other, never the value
		expect(diagnosticCode('rev_missing_extra')).toBe('other')
		expect(diagnosticCode('wallet_fields')).toBe('other')
	})
	it('a mnemonic word or any free value prints as other', () => {
		expect(diagnosticCode('abandon')).toBe('other')
		expect(diagnosticCode('legal winner thank')).toBe('other')
		expect(diagnosticCode(undefined)).toBe('other')
	})
})
