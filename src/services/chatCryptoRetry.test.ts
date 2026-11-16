/**
 * Y.81 CA-01 to CA-06 (chatAvailabilityCases in pgp-migration-vectors.v2.json, sha256 26655ea3…) and the Y.83 4 retry rule.
 * SYNTHETIC values only.
 */
import { chatCryptoAvailabilityOf, chatCryptoRetryAfter, immediateRetriesOnNetworkRestore, storageLockActionAt } from './chatCryptoRetry'

describe('Y.81 chat crypto availability (CA-01 to CA-06)', () => {
	it('CA-01: K_pgp verified: read and write on, no notice, no retry, L not used', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: true, pgpSource: 'ok', offline: false, localHistoryAvailable: true })).toEqual({
			history: 'readwrite', encryptActions: 'enabled', hint: null, retry: null, useL: false,
		})
	})

	it('CA-02: pgp_source_unavailable with local history: read only, actions disabled, the retry notice, the schedule runs', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'pgp_source_unavailable', offline: false, localHistoryAvailable: true })).toEqual({
			history: 'readonly', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', useL: false,
		})
	})

	it('CA-03: offline cold start with an old L present: L is not used, history read only', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'none', offline: true, localHistoryAvailable: true })).toEqual({
			history: 'readonly', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', useL: false,
		})
	})

	it('CA-04: no local history: never shown as "no session"; the retry notice and the schedule, actions disabled', () => {
		expect(chatCryptoAvailabilityOf({ kPgpVerified: false, pgpSource: 'pgp_source_unavailable', offline: true, localHistoryAvailable: false })).toEqual({
			history: 'hidden_with_retry', encryptActions: 'disabled', hint: 'chat_crypto_retrying', retry: 'schedule', useL: false,
		})
	})

	it('CA-05: the retry delays are 30 s, 2 min, 10 min, then manual', () => {
		expect([0, 1, 2].map((n) => chatCryptoRetryAfter(n))).toEqual([30_000, 120_000, 600_000])
		expect(chatCryptoRetryAfter(3)).toBe('manual')
	})

	it('CA-06: offline to online retries once, at once', () => {
		expect(immediateRetriesOnNetworkRestore('offline_to_online')).toBe(1)
		expect(immediateRetriesOnNetworkRestore('none')).toBe(0)
	})
})

describe('Y.83 4 storage-derived lock: three retries, then the user-started recovery entry', () => {
	it('retries on the schedule for the first three attempts, then offers the recovery entry (never automatic)', () => {
		expect(storageLockActionAt(0)).toEqual({ kind: 'retry', delayMs: 30_000 })
		expect(storageLockActionAt(1)).toEqual({ kind: 'retry', delayMs: 120_000 })
		expect(storageLockActionAt(2)).toEqual({ kind: 'retry', delayMs: 600_000 })
		expect(storageLockActionAt(3)).toEqual({ kind: 'recovery_entry' })
		expect(storageLockActionAt(9)).toEqual({ kind: 'recovery_entry' })
	})
})
