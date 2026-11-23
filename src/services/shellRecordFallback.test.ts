import { fallbackStartOutcome, nativeRecordFallbackOf, OLD_SHELL_UPGRADE_REASON, SHELL_RECORD_NOT_SUPPORTED_ERROR, SHELL_RECORD_UNKNOWN_COMMAND_ERROR, terminalEvidenceOf } from './shellRecordFallback'
import { nativeNoKeyRoute } from './accountJudgement'
import { queryNativeMnemonicPreread } from './nativeRecovery'

describe('the shell record read error classes (2026-11-21)', () => {
	test('not_supported → no native record, the page store is read next (class: definite old shell)', () => {
		expect(nativeRecordFallbackOf(SHELL_RECORD_NOT_SUPPORTED_ERROR)).toEqual({ kind: 'fallback', reason: 'not_supported' })
	})

	test('a timeout, a refusal, an origin refusal or an unknown error stays a hold (no fallback)', () => {
		for (const msg of ['shell_record_timeout', 'shell_record_origin_refused', 'shell_record_no_channel', 'shell_record_bad_answer', 'shell_record_locked', 'timeout', 'unknown']) {
			expect(nativeRecordFallbackOf(msg)).toBeNull()
		}
	})

	test('other shell_record reasons other than not_supported are not treated as a missing command', () => {
		expect(nativeRecordFallbackOf('shell_record_wallet_fields_redacted')).toBeNull()
		expect(nativeRecordFallbackOf('shell_record_not_supported_extra')).toBeNull()
	})
})

describe('iOS unknown_command is the same definite class as Android not_supported', () => {
	test('shell_record_unknown_command → fallback', () => {
		expect(nativeRecordFallbackOf(SHELL_RECORD_UNKNOWN_COMMAND_ERROR)).toEqual({ kind: 'fallback', reason: 'unknown_command' })
	})
	test('other iOS errors (timeout, no_channel, bad_answer) stay a hold', () => {
		for (const msg of ['shell_record_timeout', 'shell_record_no_channel', 'shell_record_bad_answer', 'shell_record_native_unavailable']) {
			expect(nativeRecordFallbackOf(msg)).toBeNull()
		}
	})
})

describe('the fallback shell start outcome (the decision, 2026-11-21): no walletEoaAddress, no native write', () => {
	test('page store holds an account → enter /chat', () => {
		expect(fallbackStartOutcome({ legacy: 'valid' })).toBe('enter')
	})
	test('page store confirmed empty → the terminal update prompt (never onboarding, whatever walletEoaAddress says)', () => {
		expect(fallbackStartOutcome({ legacy: 'absent' })).toBe('terminal')
	})
	test('read failure, timeout or unknown → wait', () => {
		expect(fallbackStartOutcome({ legacy: 'unknown' })).toBe('wait')
	})
	test('the terminal reason name is fixed for the gate', () => {
		expect(OLD_SHELL_UPGRADE_REASON).toBe('old_shell_upgrade_required')
	})
})

describe('the pre-read of a shell that cannot answer it (2026-11-21)', () => {
	test('not_supported from the pre-read transport is the legacy class (unknown, reason unsupported), not a retry', async () => {
		const out = await queryNativeMnemonicPreread(() => 1, async () => ({ kind: 'not_supported' }))
		expect(out).toEqual({ kind: 'unknown', reason: 'unsupported' })
	})
	test('the legacy route is taken for an unsupported pre-read (no pre_unknown retry)', () => {
		expect(nativeNoKeyRoute({ kind: 'unknown', reason: 'unsupported' })).toBe('retry')
		expect(nativeNoKeyRoute({ kind: 'unknown' })).toBe('retry')
	})
})


describe('the gate reads the terminal of the storage read as page evidence (the first page read must not turn it into unknown)', () => {
	test('the update-prompt terminal is terminal evidence, not unknown (iOS and Android take the same path)', () => {
		expect(terminalEvidenceOf({ status: 'unavailable', reason: OLD_SHELL_UPGRADE_REASON })).toEqual({ kind: 'terminal' })
	})
	test('a read failure, a timeout or a loaded/empty status is not terminal evidence', () => {
		expect(terminalEvidenceOf({ status: 'unavailable', reason: 'native_retry' })).toBeNull()
		expect(terminalEvidenceOf({ status: 'unavailable', reason: 'timeout' })).toBeNull()
		expect(terminalEvidenceOf({ status: 'loaded' })).toBeNull()
		expect(terminalEvidenceOf({ status: 'empty' })).toBeNull()
	})
	test('the reason carried by the fallback is the real one: iOS unknown_command, Android not_supported', () => {
		expect(nativeRecordFallbackOf(SHELL_RECORD_UNKNOWN_COMMAND_ERROR)?.reason).toBe('unknown_command')
		expect(nativeRecordFallbackOf(SHELL_RECORD_NOT_SUPPORTED_ERROR)?.reason).toBe('not_supported')
	})
})

describe('untrusted_source is not a fallback', () => {
	test('shell_record_untrusted_source is not a definite old-shell class: no page entry, no fallback', () => {
		expect(nativeRecordFallbackOf('shell_record_untrusted_source')).toBeNull()
	})
	test('locked is a hold and is not a fallback either', () => {
		expect(nativeRecordFallbackOf('shell_record_locked')).toBeNull()
	})
})
