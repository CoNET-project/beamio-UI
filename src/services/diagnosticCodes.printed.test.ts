/**
 * 0.53.44 closed set, checked on the real log path: each new PWA-internal reason is printed as itself by the read log line
 * (`reason=${diagnosticCode(parsed.reason)}` in shellRecordStore) and by the startup decision line (`store=error(${diagnosticCode(...)})`).
 * A code outside the closed set prints as other. The reasons come from the real parser (parseShellRecordRead) and the real
 * storage-error mapping (shellRecordAsWalletRecord), not from a hand-written table.
 */
import { diagnosticCode, DIAGNOSTIC_CODES } from './diagnosticCodes'
import { parseShellRecordRead, shellRecordAsWalletRecord } from './shellRecordStore'

const NEW_CODES = ['rev_missing', 'bad_answer', 'wallet_fields_missing', 'wallet_fields_redacted', 'native_unavailable', 'needs_native_recovery'] as const
const EOA = '0x9858effd232b4033e47d90003d41ec34ecaeda94'

describe('0.53.44 closed set: the new reason codes are printed as themselves on the log path', () => {
	it('each new code is in the closed set and prints as itself', () => {
		for (const c of NEW_CODES) {
			expect(DIAGNOSTIC_CODES.has(c)).toBe(true)
			expect(diagnosticCode(c)).toBe(c)
		}
	})

	it('rev_missing: an ok answer whose record has no integer rev is parsed to rev_missing, and the read log prints it', () => {
		const parsed = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: { profiles: [{ keyID: EOA }] } } })
		expect(parsed).toMatchObject({ status: 'error', reason: 'rev_missing' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('rev_missing')
	})

	it('bad_answer: an ok envelope with no result is parsed to bad_answer, and the read log prints it', () => {
		const parsed = parseShellRecordRead({ type: 'ack', ok: true, result: null })
		expect(parsed).toMatchObject({ status: 'error', reason: 'bad_answer' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('bad_answer')
	})

	it('native_unavailable: a reply that is not an ack is parsed to native_unavailable, and the read log prints it', () => {
		const parsed = parseShellRecordRead({ type: 'nope' })
		expect(parsed).toMatchObject({ status: 'error', reason: 'native_unavailable' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('native_unavailable')
	})

	it('needs_native_recovery: the native error sub is parsed to needs_native_recovery, and the read log prints it', () => {
		const parsed = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'error', sub: 'needs_native_recovery' } })
		expect(parsed).toMatchObject({ status: 'error', reason: 'needs_native_recovery' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('needs_native_recovery')
	})

	it('wallet_fields_missing: an ok record with no profile list (no wallet fields) is parsed to wallet_fields_missing, and the read log prints it', () => {
		const parsed = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'ok', record: { rev: 1 } } })
		expect(parsed).toMatchObject({ status: 'error', reason: 'wallet_fields_missing' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('wallet_fields_missing')
	})

	it('wallet_fields_redacted: the storage-error message of a redacted answer is printed as wallet_fields_redacted (decision-inputs line)', () => {
		let message = ''
		try {
			shellRecordAsWalletRecord({ status: 'ok', record: { rev: 1, profiles: [{ keyID: EOA }] }, rev: 1, walletFieldsRedacted: true } as never)
		} catch (e) {
			message = e instanceof Error ? e.message : String(e)
		}
		expect(message).toBe('shell_record_wallet_fields_redacted')
		// the startup decision line prints diagnosticCode(msg.replace(^shell_record_, ''))
		expect(diagnosticCode(message.replace(/^shell_record_/, ''))).toBe('wallet_fields_redacted')
	})

	it('outside the closed set: a code that is not listed prints as other, including near-misses of the new codes', () => {
		const parsed = parseShellRecordRead({ type: 'ack', ok: true, result: { code: 'error', sub: 'some_new_reason' } })
		expect(parsed).toMatchObject({ status: 'error', reason: 'some_new_reason' })
		expect(diagnosticCode((parsed as { reason: string }).reason)).toBe('other')
		expect(diagnosticCode('rev_missing_extra')).toBe('other')
		expect(diagnosticCode('needs_native')).toBe('other')
		expect(diagnosticCode(EOA)).toBe('other')
	})
})
