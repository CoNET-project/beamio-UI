/**
 * The printable code whitelist: listed codes print as themselves, anything else as other.
 */
import { diagnosticCode, DIAGNOSTIC_CODES } from './diagnosticCodes'

describe('diagnosticCode (the spec-checked whitelist)', () => {
	it('the codes kept with provenance are printable', () => {
		for (const c of ['not_supported', 'locked', 'no_key', 'not_reported', 'key_only', 'unknown', 'present', 'unavailable']) {
			expect(diagnosticCode(c)).toBe(c)
		}

		for (const c of ['bad_request', 'key_over_bridge_refused', 'not_trusted', 'record_unreadable', 'wallet_copy_not_approved', 'legacy_store_unreadable', 'address_mismatch', 'conflict', 'pgp_private_in_payload', 'untrusted_source']) {
			expect(DIAGNOSTIC_CODES.has(c)).toBe(true)
			expect(diagnosticCode(c)).toBe(c)
		}
	})
	it('codes removed by are not printable', () => {
		for (const c of ['native_unavailable', 'bad_answer', 'unknown_command', 'timeout', 'unlocked', 'corrupt']) {
			expect(diagnosticCode(c)).toBe('other')
		}
	})
	it('a mnemonic word or any free value prints as other', () => {
		expect(diagnosticCode('abandon')).toBe('other')
		expect(diagnosticCode('legal winner thank')).toBe('other')
		expect(diagnosticCode(undefined)).toBe('other')
	})
})
